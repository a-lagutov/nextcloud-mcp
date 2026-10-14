/**
 * Helpers for local files: open as a streamable Blob, walk folders,
 * and run tasks in a bounded pool.
 */

import { openAsBlob } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

/** Local file opened for upload. */
export interface LocalFile {
  name: string;
  size: number;
  blob: Blob;
}

/**
 * Open a local file for streaming upload.
 * @param localPath - absolute path on this machine
 * @throws if the path does not exist or is not a regular file
 */
export async function openLocalFile(localPath: string): Promise<LocalFile> {
  const fileStat = await stat(localPath);
  if (!fileStat.isFile()) {
    throw new Error(`Not a regular file: ${localPath}`);
  }
  // openAsBlob streams from disk on read, so large files are not loaded into memory
  const blob = await openAsBlob(localPath);
  return { name: basename(localPath), size: fileStat.size, blob };
}

/**
 * Walk a local folder recursively.
 * @param rootPath - absolute folder path
 * @returns relative folder and file paths with "/" separators, parents before children
 */
export async function walkLocalFolder(rootPath: string): Promise<{ folders: string[]; files: string[] }> {
  const folders: string[] = [];
  const files: string[] = [];
  const entries = await readdir(rootPath, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    // Hidden system clutter like .DS_Store is never worth uploading
    if (entry.name === ".DS_Store" || entry.name === "Thumbs.db") continue;
    const relativePath = relative(rootPath, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (entry.isDirectory()) folders.push(relativePath);
    else if (entry.isFile()) files.push(relativePath);
  }
  // Fewer segments first, so every parent is created before its children
  folders.sort((first, second) => first.split("/").length - second.split("/").length);
  return { folders, files };
}

/**
 * Run an async task for every item with at most `concurrency` tasks at once.
 * @param items - work items
 * @param concurrency - max simultaneous tasks
 * @param task - async handler; a rejection stops the pool
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    // Single-threaded JS: reading and bumping nextIndex is atomic between awaits
    while (nextIndex < items.length) {
      await task(items[nextIndex++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
