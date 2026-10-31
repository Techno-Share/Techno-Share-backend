FROM node:20-alpine
# No LibreOffice, and no fonts for it.
#
# This image carried `libreoffice` plus five font packages so OfficeConvertService
# could render .docx/.pptx into PDF previews. That conversion was removed — it
# parsed untrusted uploads in-process, which was the largest such surface left
# after the malware scanner went, and it cost roughly 400 MB of image for a
# convenience feature.
#
# If inline office previews are ever wanted again, render them in a separate
# container with no network and no credentials rather than inside the API.

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]
