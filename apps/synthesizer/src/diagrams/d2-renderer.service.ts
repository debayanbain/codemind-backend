import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { CompileOptions, CompileResponse } from '@terrastruct/d2';
import { normalizeSvgForHtml, sanitizeSvg } from '@app/common';
import { D2_THEME_DARK, D2_THEME_LIGHT } from './palette';

type D2Module = typeof import('@terrastruct/d2');
type D2Instance = InstanceType<D2Module['D2']>;

/**
 * `@terrastruct/d2`'s own `.d.ts` types `compile`'s second argument as
 * `Omit<CompileRequest, 'fs'>` — i.e. `{ options: CompileOptions }`. Its runtime
 * disagrees: it does `{ fs: { index: input }, options: secondArg }`, so the
 * options belong at the top level.
 *
 * This is not cosmetic. Passing the nested shape the types demand compiles fine
 * and then silently ignores `layout`, so every diagram lays out with `dagre` no
 * matter what you asked for. Verified by comparing shape coordinates: flat
 * `{layout:'elk'}` moves them, nested `{options:{layout:'elk'}}` does not.
 */
type CompileFn = (
  input: string,
  options: CompileOptions,
) => Promise<CompileResponse>;

export interface D2RenderOptions {
  /** Salts generated element ids so two identical diagrams can share one page. */
  salt: string;
  layout?: 'dagre' | 'elk';
}

/** A compile+render pair is ~200ms warm. 20s means something is wrong, not slow. */
const RENDER_TIMEOUT_MS = 20_000;
/** Bounds blast radius if an agent hallucinates a thousand modules. */
const MAX_SOURCE_BYTES = 64 * 1024;

@Injectable()
export class D2Renderer implements OnModuleDestroy {
  private readonly logger = new Logger(D2Renderer.name);

  private instance: D2Instance | null = null;
  private instancePromise: Promise<D2Instance> | null = null;

  /**
   * Serialises every call into the WASM instance.
   *
   * `@terrastruct/d2` runs the Go/WASM binary in one worker thread and tracks
   * exactly one in-flight request per instance — `sendMessage` overwrites a
   * single `currentResolve` field. Two concurrent `compile()` calls therefore
   * make the first promise hang forever while the second resolves with the
   * first's result. This is not theoretical; it reproduces on the first try.
   * The library exposes no queue of its own, so we own the lock.
   */
  private lock: Promise<unknown> = Promise.resolve();

  async onModuleDestroy(): Promise<void> {
    await this.terminate();
  }

  /**
   * Renders D2 source to a standalone SVG string.
   *
   * Never throws: a diagram that won't compile becomes a visible placeholder.
   * A report where the security graph didn't lay out is still worth far more
   * than no report, and the agent tokens are already spent by this point.
   */
  async render(
    source: string,
    opts: D2RenderOptions,
  ): Promise<{ svg: string; degraded: boolean }> {
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
      this.logger.warn(`D2 source over ${MAX_SOURCE_BYTES}B [${opts.salt}]`);
      return {
        svg: this.fallbackSvg('Diagram too large to render'),
        degraded: true,
      };
    }

    return this.serialize(async () => {
      try {
        return {
          svg: await this.compileAndRender(source, opts),
          degraded: false,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`D2 render failed [${opts.salt}]: ${message}`);

        // A timeout means the worker may still be mid-request. Its late reply
        // would resolve whichever promise is holding `currentResolve` by then —
        // i.e. the *next* diagram would silently receive this one's SVG. The
        // only safe recovery is to throw the whole instance away.
        await this.terminate();
        return {
          svg: this.fallbackSvg('Diagram could not be rendered'),
          degraded: true,
        };
      }
    });
  }

  private async compileAndRender(
    source: string,
    opts: D2RenderOptions,
  ): Promise<string> {
    const d2 = await this.getInstance();

    const compile = d2.compile.bind(d2) as unknown as CompileFn;

    const svg = await withTimeout(
      (async () => {
        const compiled = await compile(source, {
          layout: opts.layout ?? 'dagre',
          themeID: D2_THEME_LIGHT,
          // D2 emits a `prefers-color-scheme: dark` block into the SVG itself,
          // so one stored string serves light frontend, dark frontend and PDF.
          darkThemeID: D2_THEME_DARK,
          pad: 16,
        });
        return d2.render(compiled.diagram, {
          ...compiled.renderOptions,
          // Keep the XML prolog out — this SVG gets inlined into HTML, where a
          // `<?xml ...?>` tag is invalid.
          noXMLTag: true,
          salt: opts.salt,
          center: true,
        });
      })(),
      RENDER_TIMEOUT_MS,
    );

    return normalizeSvgForHtml(sanitizeSvg(svg));
  }

  /** Lazily boots the worker + 22MB WASM module. First compile pays ~1.5s. */
  private async getInstance(): Promise<D2Instance> {
    if (this.instance) return this.instance;

    // `@terrastruct/d2` ships as ESM only — its advertised CommonJS build sets
    // `module.exports` inside a `"type": "module"` package, so `require()` of it
    // throws. A dynamic import is the only way in. Our tsconfig uses
    // `module: nodenext`, which preserves this as a real `import()` in the CJS
    // output rather than downlevelling it to `require()`.
    this.instancePromise ??= (async () => {
      const { D2 } = await import('@terrastruct/d2');
      const created = new D2();
      this.instance = created;
      this.logger.log('D2 WASM renderer initialised');
      return created;
    })().catch((err: unknown) => {
      this.instancePromise = null;
      throw err;
    });

    return this.instancePromise;
  }

  private async terminate(): Promise<void> {
    const dying = this.instance;
    this.instance = null;
    this.instancePromise = null;
    if (!dying) return;

    // No public teardown API; the worker handle is an internal field. Without
    // this the process keeps a live worker thread and never exits cleanly.
    const worker = (
      dying as unknown as { worker?: { terminate?: () => unknown } }
    ).worker;
    try {
      await worker?.terminate?.();
    } catch {
      // Already dead — nothing to reclaim.
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    // Keep the chain alive after a rejection, and don't retain results.
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private fallbackSvg(message: string): string {
    const text = message.replace(/[<>&"]/g, '');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 80" width="100%" role="img" aria-label="${text}">
      <rect x="1" y="1" width="418" height="78" rx="8" fill="none" stroke="#767676" stroke-dasharray="6 4" />
      <text x="210" y="45" text-anchor="middle" font-family="ui-sans-serif, sans-serif" font-size="14" fill="#767676">${text}</text>
    </svg>`;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);
}
