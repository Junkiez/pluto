FROM node:22-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 pluto \
 && mkdir /data && chown pluto:pluto /data
COPY --from=build /src/example/pluto /usr/local/bin/pluto
COPY --from=build --chown=pluto:pluto /src/example/getting-started.json /src/example/sql.json /src/example/dataframes.json /data/

USER pluto
WORKDIR /data
VOLUME /data
ENV PORT=9999
EXPOSE 9999
CMD ["pluto", "--file", "/data/getting-started.json"]
