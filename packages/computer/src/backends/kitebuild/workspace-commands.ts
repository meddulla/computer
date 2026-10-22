// The Worker shell's `assets` and `artifacts` commands, as JS programs
// on a Kitebuild machine. Both call clients on the Workspace host, which
// read and write the Workspace store outside the machine, so the
// programs commit the machine's buffered writes first and apply what
// the call changed to the mounts afterwards.

import { currentRev } from "@cloudflare/dofs";
import { type JsProgramCtx, type ProgramSpec, writeFdBytes } from "@cloudflare/kitebuild-core";

import type { WorkspaceBackendHost } from "../../backend";
import {
  type CommandResult,
  runArtifactsCommand,
  runAssetsCommand,
} from "../workspace-commands";

export interface WorkspaceCommandsHost {
  readonly host: WorkspaceBackendHost;
  /** Commit the mounts' buffered writes to the Workspace store. */
  flush(): void;
  /** Apply Workspace paths changed after store revision `since` to the mounts. */
  refreshAfter(since: number): Promise<void>;
}

export function workspacePrograms({
  host,
  flush,
  refreshAfter,
}: WorkspaceCommandsHost): ProgramSpec[] {
  return [
    {
      path: "/usr/bin/assets",
      abi: "js",
      main: async (ctx) => {
        const assets = host.assets;
        const publish =
          assets &&
          ((path: string, options: { expiresAfter: number }) => {
            flush();
            return assets.share(path, options);
          });
        return write(ctx, await runAssetsCommand(ctx.argv.slice(1), ctx.proc.cwd, publish));
      },
    },
    {
      path: "/usr/bin/artifacts",
      abi: "js",
      main: async (ctx) => {
        flush();
        // The create shorthand adds a git remote through the host.
        const before = currentRev(host.db);
        const result = await runArtifactsCommand(
          host,
          ctx.argv.slice(1),
          ctx.proc.cwd,
          environment(ctx.envp),
        );
        if (currentRev(host.db) !== before) await refreshAfter(before);
        return write(ctx, result);
      },
    },
  ];
}

function environment(envp: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of envp) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

function write(ctx: JsProgramCtx, result: CommandResult): number {
  for (const [fd, text] of [
    [1, result.stdout],
    [2, result.stderr],
  ] as const) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > 0) writeFdBytes(ctx.proc.fdt, fd, bytes, 0, bytes.length);
  }
  return result.exitCode;
}
