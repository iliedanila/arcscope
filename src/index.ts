#!/usr/bin/env node
import { logError } from './log.js';

// Single bin, branches on argv. Subcommands are imported lazily so `init` doesn't
// pay to load the MCP SDK and `serve` starts with a clean module graph.
const command = process.argv[2];
const root = process.cwd();

try {
  switch (command) {
    case 'init': {
      const { init } = await import('./init/init.js');
      await init(root);
      break;
    }
    case 'serve': {
      const { serve } = await import('./server/serve.js');
      await serve(root);
      break;
    }
    default: {
      process.stderr.write(
        'arcscope — fully-local, architecture-aware code-navigation MCP server\n\n' +
          'Usage:\n' +
          '  arcscope init    Index this repo, write .mcp.json, and update .gitignore\n' +
          '  arcscope serve   Run the MCP server over stdio (spawned by your MCP client)\n',
      );
      process.exit(command ? 1 : 0);
    }
  }
} catch (err) {
  logError(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
}
