"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, "dist");
const SERVER_DIR = path.join(DIST_DIR, "server");
const WORKER_TEMPLATE_PATH = path.join(ROOT_DIR, "sites-worker-template.mjs");

const assetDefinitions = [
  ["/index.html", { contentType: "text/html; charset=utf-8", protected: true, source: "index.html" }],
  ["/login.html", { contentType: "text/html; charset=utf-8", protected: false, source: "login.html" }],
  ["/styles.css", { contentType: "text/css; charset=utf-8", protected: false, source: "styles.css" }],
  ["/app.js", { contentType: "text/javascript; charset=utf-8", protected: true, source: "app.js" }],
  ["/login.js", { contentType: "text/javascript; charset=utf-8", protected: false, source: "login.js" }],
];

buildSitesOutput();

function buildSitesOutput() {
  const workerTemplate = fs.readFileSync(WORKER_TEMPLATE_PATH, "utf8");
  const serializedAssets = serializeAssets();
  const workerCode = workerTemplate.replace("__ASSET_MAP__", serializedAssets);

  fs.rmSync(DIST_DIR, { force: true, recursive: true });
  fs.mkdirSync(SERVER_DIR, { recursive: true });
  fs.writeFileSync(path.join(SERVER_DIR, "index.js"), workerCode, "utf8");
}

function serializeAssets() {
  const assetMap = {};

  for (const [routePath, definition] of assetDefinitions) {
    const sourcePath = path.join(ROOT_DIR, definition.source);
    const body = fs.readFileSync(sourcePath, "utf8");

    assetMap[routePath] = {
      body,
      contentType: definition.contentType,
      protected: definition.protected,
    };
  }

  return JSON.stringify(assetMap);
}
