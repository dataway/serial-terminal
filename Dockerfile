FROM docker.io/joseluisq/static-web-server:2.44.0-alpine

ENV SERVER_PORT=8080

COPY --chown=sws:sws dist/ /home/sws/public/
