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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JobsService } from './jobs.service';

type ExportFormat = 'md' | 'pdf';

/**
 * Mermaid.js pulled from a CDN and initialized client-side — md-to-pdf renders
 * via Puppeteer, so this script actually executes and diagrams rasterize
 * before the PDF is captured (they don't just show up as code blocks).
 */
const MERMAID_SCRIPT = `
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: true, theme: 'default' });
</script>
<style>
  .language-mermaid { background: transparent !important; }
</style>
`;

const PDF_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  pre { background: #f5f5f5; padding: 1em; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ddd; padding: 8px; }
  th { background: #f2f2f2; }
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
        const pdf = await mdToPdf(
          { content: this.injectMermaid(report.markdownContent) },
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

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="report-${jobId}.md"`,
    );
    res.send(report.markdownContent);
  }

  /** Replace ```mermaid fences with <div class="mermaid"> so Mermaid.js picks them up. */
  private injectMermaid(markdown: string): string {
    const withDivs = markdown.replace(
      /```mermaid\n([\s\S]*?)```/g,
      (_match, code: string) => `<div class="mermaid">\n${code}\n</div>`,
    );
    return withDivs + '\n\n' + MERMAID_SCRIPT;
  }
}
