#!/usr/bin/env node
// Helper pinado determinístico para runtime Graft 0.18.0
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

process.env.DO_NOT_TRACK = "1";

const PINNED_VERSION = "0.18.0";
const DIST_CLAUDE = "/Users/guilhermevarela/orchestrator/.tmp/tools/graft-0.18.0/node_modules/@nanonets/graft/dist/claude";

function verifyRuntime() {
  const targetFile = path.join(DIST_CLAUDE, "statusline.js");
  if (!fs.existsSync(targetFile)) {
    process.stderr.write(`error: Runtime Graft pinado ausente: ${targetFile}\n`);
    process.exit(1);
  }
  const pkgJsonPath = path.join(DIST_CLAUDE, "..", "..", "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    process.stderr.write(`error: package.json do Graft não encontrado em ${pkgJsonPath}\n`);
    process.exit(1);
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    if (pkg.version !== PINNED_VERSION) {
      process.stderr.write(`error: Versão do runtime Graft divergente: esperado ${PINNED_VERSION}, obtido ${pkg.version}\n`);
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`error: Falha ao validar versão do runtime: ${e}\n`);
    process.exit(1);
  }
  return targetFile;
}

const entryTarget = verifyRuntime();

import(pathToFileURL(entryTarget).href)
  .then((m) => m.main())
  .catch((err) => {
    process.stderr.write(`error: Falha na execução do statusline: ${err}\n`);
    process.exit(1);
  });
