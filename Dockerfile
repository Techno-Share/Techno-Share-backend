FROM node:20-alpine
# ── Fonts for the PDF previews ───────────────────────────────────────────────
#
# A .docx embeds no fonts. It names them — "Times New Roman", "Khmer OS
# Battambang" — and expects the machine opening it to have them. LibreOffice
# can only draw with what is installed here, so every face missing from this
# image is silently substituted, and the preview stops matching the document
# the student actually wrote.
#
#   font-noto-khmer   Khmer coverage. Without ANY Khmer face, substitution
#                     lands on a font with no Khmer glyphs and every character
#                     is baked into the PDF as a tofu box. The Latin text in
#                     the same page still looks right, which is what makes it
#                     read like a browser bug rather than a missing font here.
#   font-liberation   Metric-compatible with Times New Roman, Arial and
#                     Courier New — the three the office suite assumes and
#                     none of which may be shipped. Metric-compatible means
#                     the glyph widths match, so line breaks and page counts
#                     match too; DejaVu alone renders but reflows.
#   ttf-dejavu        Broad fallback for anything the above miss.
#   ttf-freefont      The same, for symbol ranges.
RUN apk add --no-cache \
      libreoffice \
      ttf-freefont \
      ttf-dejavu \
      font-noto-khmer \
      font-liberation

# Khmer OS — the faces Cambodian documents actually name (Battambang, Muol
# Light, Siemreap …). Noto Khmer above makes Khmer legible; these make it look
# like the original, which for a thesis cover page is the difference between a
# preview and a facsimile.
#
# Not in Alpine's repos, so taken from Debian's fonts-khmeros, pinned to a
# version rather than "latest" so an image built next year matches this one.
# Open Forum of Cambodia's fonts, DFSG-free — Debian ships them in main.
#
# The build FAILS if the download does: a silent skip would ship an image that
# renders every Khmer thesis in the wrong typeface with nothing in any log.
RUN apk add --no-cache --virtual .khmeros-build binutils curl tar xz \
 && curl -fsSL -o /tmp/khmeros.deb \
      "http://deb.debian.org/debian/pool/main/f/fonts-khmeros/fonts-khmeros_5.0-9_all.deb" \
 && cd /tmp && ar x khmeros.deb && tar xf data.tar.* \
 && mkdir -p /usr/share/fonts/khmeros \
 && cp /tmp/usr/share/fonts/truetype/khmeros/*.ttf /usr/share/fonts/khmeros/ \
 && fc-cache -f \
 && fc-list ":lang=km" family | grep -q "Khmer OS" \
 && rm -rf /tmp/khmeros.deb /tmp/usr /tmp/data.tar.* /tmp/control.tar.* /tmp/debian-binary \
 && apk del .khmeros-build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]
