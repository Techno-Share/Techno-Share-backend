# File upload flow

How a file gets from the upload form to a document other students can open.

Two things make this more than a single `POST`: files are **staged before the
form is submitted**, so the transfer overlaps with the user typing; and an
upload is **not visible until a moderator approves it**, so "uploaded" and
"published" are different moments.

---

## The short version

```
pick a file ──▶ POST /documents/staged-files ──▶ MinIO + staged_files row
                     (one call per file, while the form is still open)

submit form ──▶ POST /documents (staged_file_ids + metadata)
                     └─▶ uploads row (status: pending)
                     └─▶ documents row per file
                     └─▶ notify reviewers (fire-and-forget)

moderator   ──▶ PATCH /admin/documents/group/:id/approve
                     └─▶ uploads.status = 'active'  ──▶ now in the feed
```

---

## 1. Staging — one call per file

`POST /documents/staged-files` · guard `JwtAuthGuard` · rate tier `upload`

The form calls this the moment a file is picked, so a 15 MB PDF is already on
its way while the student is still choosing a subject. It returns a handle the
form holds until submit.

What happens per call, in order:

| Step                     | Detail                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Multer intercepts     | `memoryStorage()`, `limits.fileSize` 20 MB, `fileFilter` against the MIME allowlist. Rejected before the handler runs.                                                                                                                                                                                                                                                                                                  |
| 2. Stale sweep           | `purgeStaleStaged(uploaderId)` deletes this user's staged rows older than **24 h**, objects included. No scheduler — the cost rides along with the next upload, and it only touches the caller's own rows.                                                                                                                                                                                                              |
| 3. Decode the name       | `decodeUploadName()` — multipart filenames arrive latin1-decoded, so `តេស្ត.png` would otherwise be stored mangled. Guarded: bytes that are not valid UTF-8 are handed back untouched rather than corrupted twice.                                                                                                                                                                                                      |
| 4. Reserve quota         | The per-user byte budget is charged the bytes **received**, before anything expensive runs. Charging the stored size instead would leave the abuse this bounds — pushing volume at the server — wide open, since Sharp can shrink a 20 MB photo to 200 KB. A file rejected at step 5 stays charged, deliberately: otherwise invalid bytes would be free to send without limit. Refunded only if the write itself fails. |
| 5. Validate the bytes    | `validateFileContent()` reads the magic bytes and confirms they match the extension. A `.jpg` carrying HTML is refused here, before anything is written.                                                                                                                                                                                                                                                                |
| 6. Check the structure   | Container formats are opened far enough to prove they are real: a ZIP must have a parseable central directory, and a `.docx`/`.pptx` must contain `[Content_Types].xml`. A four-byte header with junk behind it is refused here. **No malware scan runs** — see below.                                                                                                                                                  |
| 7. Optimise, if an image | JPEG/PNG go through Sharp: capped at 1920px on the longest edge, never upscaled, metadata stripped by the re-encode. Everything else is stored byte-for-byte.                                                                                                                                                                                                                                                           |
| 8. Put the object        | Key is `staged/<uploaderId>/<uuid>.<ext>` in the private `documents` bucket — a v4 UUID, carrying nothing of the original filename.                                                                                                                                                                                                                                                                                     |
| 9. Build a preview       | Office files only (`ppt pptx doc docx …`) — LibreOffice renders a PDF beside the original: 45 s timeout killed with SIGKILL, inputs over 25 MB skipped, renditions over 60 MB discarded, at most 2 conversions at once. **Best effort**: on failure `preview_url` stays null and the upload still succeeds.                                                                                                              |
| 10. Record the handle    | A `staged_files` row: `file_url`, `storage_key`, `preview_url`, `preview_key`, `original_name`, `file_size_kb`.                                                                                                                                                                                                                                                                                                         |

If the row fails to save, the objects just written are removed again — a staged
file never exists in storage without a row pointing at it.

**Removing a file from the form** calls `DELETE /documents/staged-files/:id`,
which checks ownership before deleting the row and its objects.

### Allowed types

PDF · DOC/DOCX · PPT/PPTX · JPEG · PNG · ZIP · RAR.

Checked **twice**, and the second check is the one that counts:

1. Multer's `fileFilter` rejects on `file.mimetype` — cheap, and it stops the
   obvious cases before the body is buffered.
2. `validateFileContent()` reads the magic bytes and requires them to agree with
   the **extension**. `file.mimetype` is whatever the client declared, so it is
   never the final word.

The Office formats are the subtle case: `.docx`/`.pptx` are ZIP containers and
their legacy `.doc`/`.ppt` counterparts are OLE2 compound files, so both
families are accepted for those extensions — and neither is accepted for `.png`.

A refusal answers `400 Unsupported or invalid file type.` and nothing more. What
was declared, what was detected and why it was refused go to the security log,
where they are useful, rather than to the uploader, who would use them to find
what does get through.

---

## 2. Submit — claiming the staged files

`POST /documents` · guard `JwtAuthGuard` · rate tier `upload`

The form sends metadata plus `staged_file_ids`. The same endpoint also accepts
files in the multipart body, so a client that never staged anything still works;
the two paths merge inside `uploadMany`.

Order matters here:

1. **Validate the shape** — global `ValidationPipe` with `whitelist` and
   `forbidNonWhitelisted`, so unknown fields are refused rather than ignored.
2. **Load the major, check the doc type** — `assertDocType` rejects a type that
   department cannot have (language courses and department courses offer
   different sets).
3. **Resolve the audience** — `resolveAudience` verifies every
   `(department, year)` pair really exists, and clears the audience entirely for
   a language course, since every student takes those.
4. **Create the `uploads` row** with `status: 'pending'`.
5. **Claim the files** — `claimStagedFiles` turns each staged row into a
   `documents` row and deletes the staged row.
6. **Notify reviewers** — `createForReviewers`, deliberately **not awaited**.

### Two details worth knowing

**Claiming is all-or-nothing.** Ids that are not yours, or were already claimed,
are rejected rather than skipped:

```ts
if (staged.length !== unique.length)
  throw new BadRequestException('Unknown staged file');
```

Skipping would let a bad payload produce an upload with no files in it.

**The notification is fire-and-forget.** The upload is already saved and the
student is waiting on the response. A reviewer who is not told still has the
queue in front of them; a student who sees an error because a notification
failed has lost their upload for no reason.

---

## 3. Review — where "uploaded" becomes "published"

A new upload lands `pending`, which means:

- it is **not in the feed** — not even for its own uploader
- the uploader sees it on their dashboard, badged **Under review**
- moderators of that department see it in their queue

`PATCH /admin/documents/group/:id/approve` flips `uploads.status` to `active`
and stamps `reviewed_by`. Reject sets `rejected` with a reason.

Authorisation is per-resource, not per-route: the department comes from the
**upload**, so the id in the URL decides _which_ upload is checked, never
_whether_ it is.

```ts
this.moderation.assertCanModerate(reviewer, upload.major_id);
```

---

## 4. Reading a file — the `documents` bucket is private

Nothing in the `documents` bucket is reachable by URL. `mc anonymous set none`
is applied at bucket creation, so a raw object URL answers **403** no matter who
holds it. The only way in is a presigned URL the API mints, and it mints one
only after authorising the caller.

```
GET /documents/files/:fileId/download     the original, as an attachment
GET /documents/files/:fileId/preview      the generated PDF, inline
```

`signFileAccess()` runs the checks in this order, and the order is
load-bearing:

```
load the file  →  load its upload  →  canView(audience/expiry/hidden)
               →  upload status    →  this file's own status
               →  THEN sign
```

Signing before authorising would mint a working URL for a caller about to be
refused — and a presigned URL is a bearer token that cannot be recalled for its
lifetime. Nothing in that method touches storage until every check has passed.

Refusals are **404**, matching `findOne()`: a document you may not see must not
be distinguishable from one that does not exist.

### Why list responses still carry URLs

`file_url` in a feed or review response is now a **signed, expiring** URL rather
than a permanent address. Those rows have already been through the audience
filter, so signing them is covered by the same decision that returned them, and
S3v4 presigning is a local HMAC — no round trip — so a page of two dozen files
costs microseconds.

They expire (`S3_SIGNED_URL_TTL_SECONDS`, default 300). That is why
click-to-download goes through the endpoint instead: it re-authorises and mints
a fresh link at the moment of the click.

> Signing uses a second S3 client bound to `S3_PUBLIC_URL`. An S3v4 signature
> covers the host, so a URL signed against the internal `S3_ENDPOINT`
> (`http://minio:9000` in Docker) is unreachable from a browser. Uploads and
> deletes still use the internal client.

### Storage keys

`documents.storage_key` / `preview_key` hold the canonical `"<bucket>/<key>"`
ref and are what every read resolves. `file_url` is kept for legacy rows and as
the backfill source — **it is not an authorisation mechanism**.

Keys are `<prefix>/<uuid>.<ext>`, generated server-side. They carry no part of
the uploader's filename, which lives only in `original_name`. Nothing derived
from user input reaches a storage path, and `parseRef` / `isSafeKeySegment`
refuse anything containing `..`, a leading slash, a backslash or a control
character before it can reach S3.

---

## 5. Adding files to an existing document

`POST /documents/:id/files` — uploader only. Accepts staged ids, multipart
files, or both, exactly like the create path.

The new files' status depends on what they are being added to:

| Upload status          | New file status | Why                                                                                                                                                                                                        |
| ---------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active` (approved)    | `pending`       | The file has never been reviewed. It stays hidden from everyone but the uploader, while the rest of the document stays visible — hiding one attachment must not pull an approved document out of the feed. |
| `pending` / `rejected` | `active`        | The upload's own review covers everything in it as a group.                                                                                                                                                |

Editing an upload that is not yet approved sends it back for review:
`status: 'pending'`, `rejection_reason: null`.

The response carries `needs_review`, so the client can say _"1 file added —
waiting for review"_ rather than implying it is live.

---

## Limits

| Limit                  | Value                        | Enforced at                                    |
| ---------------------- | ---------------------------- | ---------------------------------------------- |
| File size              | 20 MB                        | Multer, per file                               |
| Files per request      | 10                           | `FilesInterceptor`                             |
| Upload requests        | 60 per 10 min, per user      | rate tier `upload`                             |
| Staged file lifetime   | 24 h                         | `purgeStaleStaged`, on next stage              |
| Total bytes per user   | 200 MB / hour (configurable) | `UploadQuotaService` → 429 + `Retry-After`     |
| Image dimensions       | 1920 px longest edge         | Sharp, re-encoded                              |
| Image decode ceiling   | 50 MP                        | Sharp `limitInputPixels` — decompression bombs |
| Presigned URL lifetime | 300 s (clamped 30–600)       | `S3_SIGNED_URL_TTL_SECONDS`                    |

---

## Failure behaviour

| Failure                         | Result                                                                  |
| ------------------------------- | ----------------------------------------------------------------------- |
| Storage put fails               | `500`, nothing recorded                                                 |
| Staged row fails to save        | objects removed, `500` — no orphan in storage                           |
| Office conversion fails         | upload succeeds, `preview_url` null                                     |
| Unknown / foreign staged id     | `400`, no upload created                                                |
| Bytes fail signature validation | `400` generic message; detail to the log only                           |
| Archive has no central directory | `400` generic message; `malformed-archive` to the log only             |
| `.docx`/`.pptx` is not an OOXML package | `400`; `not-an-office-document` to the log only                 |
| Byte quota exhausted            | `429` with `Retry-After`; nothing written                               |
| Image is a decompression bomb   | refused before decoding                                                 |
| Image optimisation fails        | original bytes stored — a sharp failure does not cost an upload         |
| Bad `major_id` / `subject_id`   | FK violation mapped to `400`                                            |
| Notification fails              | upload unaffected                                                       |

---

## Where the code lives

| Piece                                                     | File                                            |
| --------------------------------------------------------- | ----------------------------------------------- |
| Endpoints, Multer config, limits                          | `src/modules/documents/documents.controller.ts` |
| `stageFile`, `claimStagedFiles`, `uploadMany`, `addFiles` | `src/modules/documents/documents.service.ts`    |
| Object put/remove, bucket names, public URL               | `src/modules/storage/storage.service.ts`        |
| Office → PDF preview                                      | `src/modules/storage/office-convert.service.ts` |
| Filename decoding                                         | `src/modules/documents/utils/upload-name.ts`    |
| Signature + structure validation                          | `src/modules/documents/utils/file-signature.ts` |
| Approve / reject                                          | `src/modules/admin/admin.service.ts`            |

---

## Malware scanning

**There is none.** The ClamAV container was removed deliberately: it held
roughly 2 GB resident for its signature database and took minutes to become
healthy on a cold start, which is the difference between this stack fitting a
small instance and not. The operator of this deployment has accepted the
residual risk in exchange for that.

What this means precisely:

- **Uploaded files are not scanned for malware.** Nothing in the system may
  describe a stored file as scanned, clean, safe or verified.
- A genuine, correctly-typed PDF carrying an exploit **passes every check we
  perform**. Type enforcement is not malware detection and must not be
  described as though it were.
- There is no scanner to be unavailable, so there is no `503` for one. A
  failure to *validate* is a `400`; a failure to *store* is a `500`. The two
  are kept distinct on purpose — see the failure table above.

What remains, and what it is actually worth:

| Control | Proves | Does not prove |
| --- | --- | --- |
| Size caps | The file is within 50 MB, and the batch within 10 | Anything about content |
| Magic bytes | The bytes are the format the **extension** claims | That the content is benign |
| Container structure | A ZIP is a real archive; a `.docx` is an OOXML package | That the archive's contents are safe |
| `Content-Disposition` | A stored file cannot execute in our origin | That it is harmless once downloaded |

The second and third together close the stored-XSS path that motivated
validation in the first place: HTML renamed to `.jpg` is refused by the
signature check, and anything that is not `pdf`/`jpg`/`png` is served
`attachment` rather than inline even if it were somehow stored.

Everything else is the uploader's responsibility and the downloader's risk,
and the platform should say so where students can read it.

## Known gaps

1. **Office previews trust LibreOffice with the file.** Conversion is bounded
   — 45 s then SIGKILL, 25 MB input ceiling, 60 MB output ceiling, at most two
   at once, isolated temp directory removed in a `finally` — and a failure only
   costs the preview. But the converter still parses untrusted input in-process,
   and with no scanner ahead of it that is now the largest untrusted-input
   surface in the service. Memory is capped at the container (`mem_limit` on the
   backend replicas) because Node cannot set an rlimit on a child. Running it in
   its own container with no network and a seccomp profile would bound it
   properly.

2. **The three image buckets are still public-read.** `user-avatar`,
   `subject-cover` and `book-covers` hold non-sensitive images rendered by plain
   `<img>` tags throughout the client. Closing them needs a read path of their
   own — either presigned URLs threaded through every serializer that returns an
   avatar or cover, or a streaming proxy endpoint. Smaller exposure than
   `documents` was, and explicitly **not** claimed as done.

3. **The byte quota is in memory.** Correct for one backend instance; a second
   replica would grant the full quota independently, making the effective limit
   N × the configured one. Same caveat and same fix as the rate limiter — move
   to Redis before scaling out. See `docs/rate-limiting.md`.

4. **Office previews trust LibreOffice with the file.** Conversion runs with a
   60 s timeout in an isolated temp directory and a failure only costs the
   preview, but the converter itself parses untrusted input. Sandboxing it
   (a container with no network, a seccomp profile) would bound that.

5. **Nothing reconciles storage against the database.** Deletes remove the
   object and the row together, and a failed upload rolls its object back — but
   a crash between the two still leaves an orphan, and nothing sweeps for one.
   `idx_documents_storage_key` exists to make that sweep cheap when it is
   written: list the bucket, subtract the keys the table knows about, and the
   remainder is garbage. **Not implemented** — the index is groundwork, not the
   job.
