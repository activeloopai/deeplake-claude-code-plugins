import type { DeeplakeApi } from "../deeplake-api.js";
import type { IFileSystem, FsStat, MkdirOptions, RmOptions, CpOptions, FileContent, BufferEncoding } from "just-bash";
interface ReadFileOptions {
    encoding?: BufferEncoding;
}
interface WriteFileOptions {
    encoding?: BufferEncoding;
}
interface DirentEntry {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
}
export declare function normPath(p: string): string;
export declare function guessMime(filename: string): string;
export declare class DeeplakeFs implements IFileSystem {
    private readonly client;
    private readonly table;
    readonly mountPoint: string;
    private files;
    private meta;
    private dirs;
    private pending;
    private flushed;
    /** Number of files loaded from the server during bootstrap. */
    get fileCount(): number;
    private flushTimer;
    private flushChain;
    private sessionPaths;
    private sessionsTable;
    private constructor();
    static create(client: DeeplakeApi, table: string, mount?: string, sessionsTable?: string): Promise<DeeplakeFs>;
    private addToTree;
    private removeFromTree;
    private scheduleFlush;
    flush(): Promise<void>;
    private _doFlush;
    private generateVirtualIndex;
    readFileBuffer(path: string): Promise<Uint8Array>;
    readFile(path: string, _opts?: ReadFileOptions | BufferEncoding): Promise<string>;
    /** Write a file with optional row-level metadata (project, description, dates). */
    writeFileWithMeta(path: string, content: FileContent, meta: {
        project?: string;
        description?: string;
        creationDate?: string;
        lastUpdateDate?: string;
    }): Promise<void>;
    writeFile(path: string, content: FileContent, _opts?: WriteFileOptions | BufferEncoding): Promise<void>;
    appendFile(path: string, content: FileContent, opts?: WriteFileOptions | BufferEncoding): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<FsStat>;
    lstat(path: string): Promise<FsStat>;
    chmod(_path: string, _mode: number): Promise<void>;
    utimes(_path: string, _atime: Date, _mtime: Date): Promise<void>;
    symlink(_target: string, linkPath: string): Promise<void>;
    link(_src: string, destPath: string): Promise<void>;
    readlink(path: string): Promise<string>;
    realpath(path: string): Promise<string>;
    mkdir(path: string, opts?: MkdirOptions): Promise<void>;
    readdir(path: string): Promise<string[]>;
    readdirWithFileTypes(path: string): Promise<DirentEntry[]>;
    rm(path: string, opts?: RmOptions): Promise<void>;
    cp(src: string, dest: string, opts?: CpOptions): Promise<void>;
    mv(src: string, dest: string): Promise<void>;
    resolvePath(base: string, path: string): string;
    getAllPaths(): string[];
}
export {};
