FROM docker.io/joseluisq/static-web-server:2.44.0

ENV SERVER_PORT=8080

COPY dist/ /public/
