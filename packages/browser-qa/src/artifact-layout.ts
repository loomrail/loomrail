import type { Stats } from "node:fs";

export const RUN_STORAGE_SEGMENT = /^run-[0-9a-f]{32}$/;

export const isSameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;
