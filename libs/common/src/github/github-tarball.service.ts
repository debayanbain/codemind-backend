import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'stream/web';
import * as tar from 'tar';

const REPOS_TMP_DIR = '/tmp/repos';

export class TarballDownloadError extends Error {}

/**
 * Downloads a repo via GitHub's tarball API and extracts it to
 * /tmp/repos/{runKey}/ — explicitly NOT `git clone` (Section 3: no git binary
 * dependency).
 *
 * `runKey` is the per-run directory name (`{jobId}-{epoch}`), NOT the bare
 * jobId: a force-stop-and-retry bumps the epoch, and an in-flight agent from
 * the superseded run can finish late and delete its own run's repo dir on
 * cleanup. Keying the directory by epoch means each run owns a distinct
 * folder, so that late cleanup can't wipe the freshly-indexed graph the new
 * run's agents depend on ("CodeGraph not initialized").
 */
@Injectable()
export class GithubTarballService {
  private readonly logger = new Logger(GithubTarballService.name);

  constructor(private readonly config: ConfigService) {}

  async downloadAndExtract(
    repoFullName: string,
    accessToken: string | null,
    jobId: string,
    runKey: string = jobId,
  ): Promise<{ repoPath: string }> {
    const repoPath = path.join(REPOS_TMP_DIR, runKey);
    const archivePath = path.join(REPOS_TMP_DIR, `${runKey}.tar.gz`);
    const maxBytes =
      this.config.get<number>('MAX_REPO_SIZE_MB', 200) * 1024 * 1024;
    const maxFiles = this.config.get<number>('MAX_REPO_FILE_COUNT', 5000);

    // Completed checkouts are now retained (not deleted post-job) so the repo
    // chat can re-open the CodeGraph read-only. Bound that retention here: keep
    // only the most recently-touched N checkouts, so /tmp/repos can't grow
    // without limit. The current runKey is never pruned.
    await this.pruneOldCheckouts(runKey);

    await fsp.mkdir(repoPath, { recursive: true });

    try {
      this.logger.log(`Downloading tarball for ${repoFullName} [job=${jobId}]`);
      const res = await fetch(
        `https://api.github.com/repos/${repoFullName}/tarball`,
        {
          headers: {
            // Public repos download unauthenticated — a Google-only user can
            // paste a public URL with no linked GitHub. A token, when present,
            // lifts the 60/hr anonymous rate limit and unlocks private repos.
            ...(accessToken ? { Authorization: `token ${accessToken}` } : {}),
            'User-Agent': 'CodeMind',
            Accept: 'application/vnd.github+json',
          },
        },
      );

      if (!res.ok || !res.body) {
        throw new TarballDownloadError(
          `GitHub tarball download failed for ${repoFullName}: ${res.status} ${res.statusText}`,
        );
      }

      // Fast path when GitHub tells us the size upfront; still counted below
      // in case the header is absent (chunked transfer).
      const declaredLength = Number(res.headers.get('content-length') ?? 0);
      if (declaredLength > maxBytes) {
        throw new TarballDownloadError(
          `Repo ${repoFullName} tarball is ${Math.round(declaredLength / 1024 / 1024)}MB, exceeds the ${maxBytes / 1024 / 1024}MB limit`,
        );
      }

      let bytesWritten = 0;
      const sizeGuard = new Transform({
        transform: (chunk: Buffer, _enc, callback) => {
          bytesWritten += chunk.length;
          if (bytesWritten > maxBytes) {
            callback(
              new TarballDownloadError(
                `Repo ${repoFullName} exceeds the ${maxBytes / 1024 / 1024}MB size limit`,
              ),
            );
            return;
          }
          callback(null, chunk);
        },
      });

      await pipeline(
        Readable.fromWeb(
          res.body as unknown as NodeWebReadableStream<Uint8Array>,
        ),
        sizeGuard,
        fs.createWriteStream(archivePath),
      );

      this.logger.log(`Extracting tarball [job=${jobId}]`);
      // GitHub tarballs wrap everything in one "{owner}-{repo}-{sha}/" directory — strip it.
      await tar.extract({ file: archivePath, cwd: repoPath, strip: 1 });

      const fileCount = await this.countFiles(repoPath);
      if (fileCount > maxFiles) {
        throw new TarballDownloadError(
          `Repo ${repoFullName} has ${fileCount} files, exceeds the ${maxFiles} file limit`,
        );
      }

      return { repoPath };
    } catch (err) {
      // Guardrail rejection or download failure — clean up whatever landed on disk
      // so /tmp/repos doesn't accumulate partial/oversized extracts.
      await fsp.rm(repoPath, { recursive: true, force: true });
      throw err;
    } finally {
      await fsp.rm(archivePath, { force: true });
    }
  }

  /**
   * Keep only the most recently-touched N checkouts under /tmp/repos, deleting
   * older ones so retained graphs (kept for the repo chat) can't grow disk
   * without bound. The current run's dir is never pruned; stray `.tar.gz`
   * archives from interrupted extracts are swept too. Best-effort — a prune
   * failure never blocks the extraction.
   */
  private async pruneOldCheckouts(currentRunKey: string): Promise<void> {
    const keep = this.config.get<number>('MAX_RETAINED_CHECKOUTS', 12);
    try {
      const entries = await fsp.readdir(REPOS_TMP_DIR, { withFileTypes: true });
      const dirs: { path: string; mtime: number }[] = [];

      for (const entry of entries) {
        const full = path.join(REPOS_TMP_DIR, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === currentRunKey) continue;
          try {
            const st = await fsp.stat(full);
            dirs.push({ path: full, mtime: st.mtimeMs });
          } catch {
            /* vanished between readdir and stat — ignore */
          }
        } else if (entry.name.endsWith('.tar.gz')) {
          await fsp.rm(full, { force: true }).catch(() => undefined);
        }
      }

      // Newest first; reserve one slot for the checkout about to be created.
      dirs.sort((a, b) => b.mtime - a.mtime);
      const stale = dirs.slice(Math.max(0, keep - 1));
      for (const d of stale) {
        await fsp
          .rm(d.path, { recursive: true, force: true })
          .catch((e: unknown) =>
            this.logger.warn(
              `Failed to prune old checkout ${d.path}: ${String(e)}`,
            ),
          );
      }
      if (stale.length) {
        this.logger.log(
          `Pruned ${stale.length} old checkout(s) from ${REPOS_TMP_DIR}`,
        );
      }
    } catch (err) {
      // /tmp/repos may not exist yet on the very first run — nothing to prune.
      this.logger.debug(`Checkout prune skipped: ${String(err)}`);
    }
  }

  private async countFiles(dir: string): Promise<number> {
    let count = 0;
    const walk = async (current: string) => {
      const entries = await fsp.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) {
          await walk(path.join(current, entry.name));
        } else {
          count++;
        }
      }
    };
    await walk(dir);
    return count;
  }
}
