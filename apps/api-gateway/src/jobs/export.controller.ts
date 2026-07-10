import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { mdToPdf } from 'md-to-pdf';
import { inlineDiagrams, RenderedDiagram } from '@app/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JobsService } from './jobs.service';

type ExportFormat = 'md' | 'pdf';

/**
 * Diagrams arrive here already rendered to SVG by the synthesizer, so the PDF
 * path is a pure Markdown -> HTML -> print. There is no diagram script to load,
 * nothing to execute, and no network access required.
 *
 * The Mermaid version of this file injected `mermaid.esm.min.mjs` from a CDN and
 * relied on Puppeteer executing it before capture — which meant an export could
 * silently emit raw code blocks whenever the CDN was slow, blocked, or the
 * capture won the race. D2 renders server-side, so that entire class of failure
 * is gone.
 */
const PDF_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  pre { background: #f5f5f5; padding: 1em; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ddd; padding: 8px; }
  th { background: #f2f2f2; }

  /* Keep a diagram and its caption on one page, and never let a wide graph
     overflow the paper — Puppeteer will not scroll for us. */
  figure.cm-diagram {
    margin: 1.5em 0;
    page-break-inside: avoid;
    break-inside: avoid;
    text-align: center;
  }
  figure.cm-diagram svg { max-width: 100%; height: auto; }
  figure.cm-diagram figcaption {
    margin-top: 0.5em;
    font-size: 0.85em;
    color: #5A5A5A;
  }
`;

@Controller('jobs/:jobId/export')
@UseGuards(JwtAuthGuard)
export class ExportController {
  private readonly logger = new Logger(ExportController.name);

  constructor(private readonly jobsService: JobsService) {}

  @Get()
  async export(
    @Param('jobId') jobId: string,
    @Query('format') format: ExportFormat = 'md',
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!['md', 'pdf'].includes(format)) {
      throw new BadRequestException('format must be md or pdf');
    }

    const userId = (req.user as { id: string }).id;
    const report = await this.jobsService.getReportForExport(jobId, userId);

    if (format === 'pdf') {
      try {
        const diagrams = report.diagrams as unknown as RenderedDiagram[];
        const html = inlineDiagrams(report.markdownContent, diagrams ?? []);

        const pdf = await mdToPdf(
          { content: html },
          {
            launch_options: {
              args: ['--no-sandbox', '--disable-setuid-sandbox'],
            },
            css: PDF_CSS,
            body_class: ['markdown-body'],
          },
        );

        if (!pdf?.content) throw new Error('md-to-pdf returned no content');

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="report-${jobId}.pdf"`,
        );
        return res.send(pdf.content);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`PDF export failed [job=${jobId}]: ${message}`);
        // Fall back to Markdown rather than fail the request outright —
        // Puppeteer/Chromium availability is an environment concern, not
        // a reason to withhold a report the user already paid tokens for.
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="report-${jobId}.md"`,
        );
        return res.send(report.markdownContent);
      }
    }

    // `.md` ships the diagram *sources*, not the SVGs: a Markdown file with a
    // readable ```d2 block round-trips through any editor, a 20KB inlined SVG
    // does not.
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="report-${jobId}.md"`,
    );
    res.send(report.markdownContent);
  }
}
