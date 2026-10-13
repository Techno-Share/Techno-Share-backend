import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createConnection, Socket } from 'net';

/**
 * Malware scanning, via clamd over TCP.
 *
 * Everything else in the upload path answers "is this file what it claims to
 * be". This answers a different question — "is it hostile" — and nothing else
 * in the platform asks it. Signature validation stops an HTML payload wearing a
 * .jpg name; it has nothing to say about a genuine, correctly-typed PDF that
 * carries an exploit, and the whole purpose of the platform is students
 * downloading each other's files.
 *
 * ── Why the protocol is written out here ─────────────────────────────────
 * INSTREAM is four lines of framing: send `zINSTREAM\0`, then each chunk as a
 * big-endian uint32 length followed by its bytes, then a zero length to finish.
 * clamd replies with one NUL-terminated line. The npm clients wrap that in
 * either a shell-out to `clamdscan` or an unmaintained socket layer; neither is
 * worth a dependency for something this small, and the framing is pinned by
 * tests that drive a real socket.
 */

export type ScanVerdict =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  /** Scanner could not be consulted. Never treat this as clean. */
  | { status: 'unavailable'; reason: string };

/** Streamed in pieces rather than one write, so a 50 MB file respects backpressure. */
const CHUNK_BYTES = 64 * 1024;

@Injectable()
export class ClamAvService implements OnModuleInit {
  private readonly logger = new Logger(ClamAvService.name);

  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly isEnabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.host = this.config.get<string>('CLAMAV_HOST') ?? 'clamav';
    this.port = Number(this.config.get<string>('CLAMAV_PORT')) || 3310;

    const timeout = Number(this.config.get<string>('CLAMAV_TIMEOUT_MS'));
    // 30 s: a 50 MB file scans in well under a second on a warm clamd, so this
    // is a hang detector rather than a budget.
    this.timeoutMs =
      Number.isFinite(timeout) && timeout >= 1000 && timeout <= 120_000
        ? timeout
        : 30_000;

    // Connecting is a different wait from scanning, and conflating them is
    // expensive: clamd on the same network answers a TCP connect in
    // milliseconds, so when it is down every upload would otherwise sit for
    // the full scan timeout before failing. Docker makes this concrete — a
    // stopped container drops packets rather than refusing them, so there is
    // no connection error to fail fast on.
    const connect = Number(
      this.config.get<string>('CLAMAV_CONNECT_TIMEOUT_MS'),
    );
    this.connectTimeoutMs =
      Number.isFinite(connect) && connect >= 200 && connect <= 30_000
        ? connect
        : 3_000;

    // Opt-out is explicit and must be typed in full. A scanner that quietly
    // turns itself off is worse than one that was never installed, because the
    // absence looks like a control from the outside.
    this.isEnabled =
      (this.config.get<string>('CLAMAV_ENABLED') ?? 'true').toLowerCase() !==
      'false';
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Say so at boot, loudly, either way.
   *
   * The failure this guards against is nobody noticing: an unreachable clamd
   * and a disabled one both mean uploads are not being scanned, and that should
   * never have to be inferred from the absence of a log line.
   */
  async onModuleInit(): Promise<void> {
    if (!this.isEnabled) {
      this.logger.warn(
        'Malware scanning is DISABLED (CLAMAV_ENABLED=false) — uploads are not scanned',
      );
      return;
    }

    const pong = await this.ping();
    if (pong) {
      this.logger.log(
        `Malware scanning active via clamd at ${this.host}:${this.port}`,
      );
    } else {
      this.logger.error(
        `clamd unreachable at ${this.host}:${this.port} — uploads will be REFUSED until it answers`,
      );
    }
  }

  /** Liveness only. Used at boot and by nothing on the request path. */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.converse((socket) => socket.write('zPING\0'));
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Scan a buffer.
   *
   * Returns a verdict rather than throwing, so the caller can tell "infected"
   * apart from "could not ask" — they are the same refusal to a user but very
   * different events to an operator.
   */
  async scan(buffer: Buffer): Promise<ScanVerdict> {
    if (!this.isEnabled) {
      return { status: 'unavailable', reason: 'scanning disabled' };
    }

    let reply: string;
    try {
      reply = await this.converse((socket) => {
        socket.write('zINSTREAM\0');
        for (let at = 0; at < buffer.length; at += CHUNK_BYTES) {
          const chunk = buffer.subarray(at, at + CHUNK_BYTES);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(chunk.length, 0);
          socket.write(header);
          socket.write(chunk);
        }
        // A zero-length chunk is what ends the stream.
        socket.write(Buffer.alloc(4));
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`clamd scan failed: ${reason}`);
      return { status: 'unavailable', reason };
    }

    return this.interpret(reply);
  }

  /**
   * Turn one clamd reply line into a verdict.
   *
   * Split out so every branch is testable without a socket. Anything
   * unrecognised is `unavailable`, never `clean` — an answer this code does not
   * understand is not evidence of safety.
   */
  interpret(reply: string): ScanVerdict {
    const line = reply.replace(/\0+$/, '').trim();

    if (/\bOK$/.test(line)) return { status: 'clean' };

    const found = /^stream:\s*(.+?)\s+FOUND$/.exec(line);
    if (found) return { status: 'infected', signature: found[1] };

    // "INSTREAM size limit exceeded. ERROR" lands here, as does anything else.
    return { status: 'unavailable', reason: line || 'empty reply' };
  }

  /**
   * One request, one reply, one socket.
   *
   * clamd closes the connection after answering, so `end` is the completion
   * signal. The timer is belt-and-braces alongside the socket timeout: a
   * half-open connection can leave both `data` and `end` pending forever, and
   * an upload must not hang on that.
   */
  private converse(send: (socket: Socket) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let out = '';
      let settled = false;

      const finish = (err: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        if (err) reject(err);
        // Replies are NUL-terminated framing, not content. Stripped once, here,
        // so every caller sees a plain string — `ping()` comparing against
        // "PONG\0" is exactly the bug this prevents.
        else resolve((value ?? '').replace(/\0+$/, ''));
      };

      // Two phases, two deadlines: a short one to get connected, then the
      // full one for the scan itself.
      let timer = setTimeout(
        () =>
          finish(
            new Error(`clamd unreachable after ${this.connectTimeoutMs}ms`),
          ),
        this.connectTimeoutMs,
      );

      socket.setTimeout(this.timeoutMs, () =>
        finish(new Error('clamd socket timed out')),
      );
      socket.on('connect', () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(new Error(`clamd timed out after ${this.timeoutMs}ms`)),
          this.timeoutMs,
        );
        try {
          send(socket);
        } catch (err) {
          finish(err instanceof Error ? err : new Error('write failed'));
        }
      });
      socket.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      socket.on('end', () => finish(null, out));
      socket.on('error', (err) => finish(err));
    });
  }
}
