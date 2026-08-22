#!/bin/bash
# Build: compile src/ -> lib/ with tsc, linking peer deps from a local DSH
# installation. Works with BOTH layouts:
#   - source checkout (packages/ + vendor/)   -> set DSH_CHECKOUT
#   - npm-installed dsh (node_modules inside) -> auto-probed (default)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NPM_DSH="${DSH_INSTALL:-$APPDATA/npm/node_modules/@deepseek-ai/dsh}"
[ -n "${DSH_INSTALL:-}" ] || NPM_DSH="${NPM_DSH:-$HOME/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh}"

CHECKOUT="${DSH_CHECKOUT:-}"
INSTALL=""
if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/packages" ]; then
  echo "=== Layout: source checkout ($CHECKOUT) ==="
elif [ -d "$NPM_DSH/node_modules/@deepseek-ai/dsh-tools" ]; then
  INSTALL="$NPM_DSH"
  echo "=== Layout: npm-installed dsh ($INSTALL) ==="
else
  # Last resort: probe common locations.
  for candidate in "$HOME/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh" \
                   "$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh" \
                   "/usr/lib/node_modules/@deepseek-ai/dsh"; do
    if [ -d "$candidate/node_modules/@deepseek-ai/dsh-tools" ]; then
      INSTALL="$candidate"; echo "=== Layout: npm-installed dsh ($INSTALL) ==="; break
    fi
  done
fi
if [ -z "$CHECKOUT" ] && [ -z "$INSTALL" ]; then
  echo "build: cannot locate a dsh installation (set DSH_CHECKOUT or DSH_INSTALL)" >&2
  exit 1
fi

link_pkg() {
  local link="node_modules/$1" target="$2"
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$link" "$target"
}

echo "=== Linking build dependencies ==="
mkdir -p node_modules/@deepseek-ai
node -e "const fs=require('fs');fs.rmSync('node_modules/@standard-schema',{recursive:true,force:true})"
if [ -n "$INSTALL" ]; then
  NM="$INSTALL/node_modules"
  link_pkg cordis "$NM/@deepseek-ai/cordis"
  link_pkg cosmokit "$NM/@deepseek-ai/cosmokit"
  link_pkg schemastery "$NM/@deepseek-ai/schemastery"
  link_pkg @deepseek-ai/dsh-tools "$NM/@deepseek-ai/dsh-tools"
  link_pkg @deepseek-ai/dsh-llm "$NM/@deepseek-ai/dsh-llm"
  link_pkg @deepseek-ai/dsh-system-prompt "$NM/@deepseek-ai/dsh-system-prompt"
  if [ -d "$NM/@deepseek-ai/dsh-commands" ]; then
    link_pkg @deepseek-ai/dsh-commands "$NM/@deepseek-ai/dsh-commands"
  fi
  # Client half: type-only imports (@deepseek-ai/dsh-client-runtime/client,
  # @deepseek-ai/dsh-client-ui-tool/client).
  if [ -d "$NM/@deepseek-ai/dsh-client-runtime" ]; then
    link_pkg @deepseek-ai/dsh-client-runtime "$NM/@deepseek-ai/dsh-client-runtime"
  fi
  if [ -d "$NM/@deepseek-ai/dsh-client-ui-tool" ]; then
    link_pkg @deepseek-ai/dsh-client-ui-tool "$NM/@deepseek-ai/dsh-client-ui-tool"
  fi
  if [ -d "$NM/@types/node" ]; then link_pkg @types/node "$NM/@types/node"; fi
  STD_SCHEMA=$(find "$NM/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1 || true)
  if [ -z "$STD_SCHEMA" ] && [ -d "$NM/@standard-schema/spec" ]; then
    STD_SCHEMA="$NM/@standard-schema"
  fi
  if [ -n "$STD_SCHEMA" ]; then
    mkdir -p node_modules/@standard-schema
    node -e "
      const fs = require('fs');
      const path = require('path');
      fs.rmSync('node_modules/@standard-schema', { recursive: true, force: true });
      fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
      fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
    " "$STD_SCHEMA/node_modules/@standard-schema/spec"
  fi
else
  link_pkg cordis "$CHECKOUT/vendor/cordis"
  link_pkg cosmokit "$CHECKOUT/vendor/cosmokit"
  link_pkg schemastery "$CHECKOUT/vendor/schemastery"
  link_pkg @deepseek-ai/dsh-tools "$CHECKOUT/packages/core/tools"
  link_pkg @deepseek-ai/dsh-llm "$CHECKOUT/packages/llm/llm"
  link_pkg @deepseek-ai/dsh-system-prompt "$CHECKOUT/packages/core/system-prompt"
  if [ -d "$CHECKOUT/packages/core/commands" ]; then
    link_pkg @deepseek-ai/dsh-commands "$CHECKOUT/packages/core/commands"
  fi
  link_pkg @types/node "$CHECKOUT/node_modules/@types/node"
  STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1 || true)
  if [ -n "$STD_SCHEMA" ]; then
    mkdir -p node_modules/@standard-schema
    node -e "
      const fs = require('fs');
      const path = require('path');
      fs.rmSync('node_modules/@standard-schema', { recursive: true, force: true });
      fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
      fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
    " "$STD_SCHEMA/node_modules/@standard-schema/spec"
  fi
fi

echo "=== Resolving tsc ==="
TSC=""
if [ -x "node_modules/.bin/tsc" ]; then TSC="node_modules/.bin/tsc"
elif [ -f "node_modules/.bin/tsc.cmd" ]; then TSC="node_modules/.bin/tsc.cmd"
elif [ -n "${DSH_TSC:-}" ] && [ -f "$DSH_TSC" ]; then TSC="$DSH_TSC"
else
  # Bootstrap a local typescript (devDependency).
  npm install --no-save --no-audit --no-fund typescript@^5.9.0 >/dev/null 2>&1 || true
  if [ -f "node_modules/.bin/tsc.cmd" ]; then TSC="node_modules/.bin/tsc.cmd"
  elif [ -x "node_modules/.bin/tsc" ]; then TSC="node_modules/.bin/tsc"
  fi
fi
if [ -z "$TSC" ]; then
  echo "build: tsc not found (set DSH_TSC or run: npm i -D typescript)" >&2
  exit 1
fi

echo "=== Compiling src -> lib ($TSC) ==="
"$TSC" -p tsconfig.json

echo "=== Compiling client bundle (tsdown) ==="
TSDOWN=""
if [ -x "node_modules/.bin/tsdown" ]; then TSDOWN="node_modules/.bin/tsdown"
elif [ -f "node_modules/.bin/tsdown.cmd" ]; then TSDOWN="node_modules/.bin/tsdown.cmd"
elif [ -n "${DSH_TSDOWN:-}" ] && [ -f "$DSH_TSDOWN" ]; then TSDOWN="$DSH_TSDOWN"
else
  # Bootstrap a local tsdown (devDependency).
  npm install --no-save --no-audit --no-fund tsdown@latest >/dev/null 2>&1 || true
  if [ -f "node_modules/.bin/tsdown.cmd" ]; then TSDOWN="node_modules/.bin/tsdown.cmd"
  elif [ -x "node_modules/.bin/tsdown" ]; then TSDOWN="node_modules/.bin/tsdown"
  fi
fi
if [ -z "$TSDOWN" ]; then
  echo "build: tsdown not found (set DSH_TSDOWN or run: npm i -D tsdown)" >&2
  exit 1
fi

"$TSDOWN" -c tsdown.config.ts

echo "=== Wrapping client bundle into ModuleLoader protocol ==="
node scripts/wrap_client.mjs

echo "=== Build complete ==="
