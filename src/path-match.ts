import { homedir } from "node:os";

export interface MemoryOp {
  path: string;
  op: "read" | "write" | "edit" | "list" | "search" | "bash";
}

function expand(p: string): string {
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

export function extractMemoryOp(
  toolName: string,
  toolInput: Record<string, unknown>,
  memoryPath: string,
): MemoryOp | null {
  const mp = expand(memoryPath);

  switch (toolName) {
    case "Read": {
      const fp = toolInput.file_path as string | undefined;
      if (fp && expand(fp).startsWith(mp)) return { path: expand(fp), op: "read" };
      break;
    }
    case "Write": {
      const fp = toolInput.file_path as string | undefined;
      if (fp && expand(fp).startsWith(mp)) return { path: expand(fp), op: "write" };
      break;
    }
    case "Edit": {
      const fp = toolInput.file_path as string | undefined;
      if (fp && expand(fp).startsWith(mp)) return { path: expand(fp), op: "edit" };
      break;
    }
    case "Glob": {
      const p = toolInput.path as string | undefined;
      if (p && expand(p).startsWith(mp)) return { path: expand(p), op: "list" };
      break;
    }
    case "Grep": {
      const p = toolInput.path as string | undefined;
      if (p && expand(p).startsWith(mp)) return { path: expand(p), op: "search" };
      break;
    }
    case "Bash": {
      const cmd = toolInput.command as string | undefined;
      if (cmd && cmd.includes(mp)) return { path: mp, op: "bash" };
      break;
    }
  }

  return null;
}
