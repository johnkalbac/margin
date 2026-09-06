/**
 * The document types Margin opens, in one place.
 *
 * This used to live in src/main/argvFiles.ts, but it is not a main-process
 * fact: the argv filter, the Open dialog's file types, and the renderer's
 * drop filter all judge the same set, and the renderer cannot import from
 * main/ (the tsconfig.web/node split). Shared is where a fact both sides
 * assert belongs — argvFiles re-exports it so its own test import path holds.
 */
export const OPENABLE_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'txt']
