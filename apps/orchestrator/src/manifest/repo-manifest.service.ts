import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';

const EXCLUDED_DIRS = new Set([
  '.git',
  '.codegraph',
  'node_modules',
  'dist',
  'build',
  'vendor',
  '.next',
  'target',
  '.venv',
  'venv',
  'Pods',
  '__pycache__',
]);

// Section 3: hard-capped to JS/TS/Python/Go for deep analysis.
const SUPPORTED_LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py'],
  go: ['.go'],
};

const MANIFEST_FILES = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
];

export interface RepoManifest {
  fileCount: number;
  totalSizeBytes: number;
  hasDockerfile: boolean;
  manifestFilesFound: string[];
  languageCounts: Record<string, number>;
  dominantLanguage: string | null;
  languageSupported: boolean;
}

@Injectable()
export class RepoManifestService {
  async build(repoPath: string): Promise<RepoManifest> {
    let fileCount = 0;
    let totalSizeBytes = 0;
    let hasDockerfile = false;
    const languageCounts: Record<string, number> = {};

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        if (EXCLUDED_DIRS.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }

        fileCount++;
        if (entry.name === 'Dockerfile') hasDockerfile = true;

        const stat = await fs.stat(fullPath);
        totalSizeBytes += stat.size;

        const ext = path.extname(entry.name);
        const lang = Object.entries(SUPPORTED_LANGUAGE_EXTENSIONS).find(
          ([, exts]) => exts.includes(ext),
        )?.[0];
        if (lang) languageCounts[lang] = (languageCounts[lang] ?? 0) + 1;
      }
    };

    await walk(repoPath);

    const manifestFilesFound: string[] = [];
    for (const f of MANIFEST_FILES) {
      try {
        await fs.access(path.join(repoPath, f));
        manifestFilesFound.push(f);
      } catch {
        // not present
      }
    }

    const dominantLanguage =
      Object.entries(languageCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      null;

    return {
      fileCount,
      totalSizeBytes,
      hasDockerfile,
      manifestFilesFound,
      languageCounts,
      dominantLanguage,
      languageSupported: dominantLanguage !== null,
    };
  }
}
