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
