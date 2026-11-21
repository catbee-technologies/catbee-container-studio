import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ElectronApiService } from '@core/electron-api.service';
import { ErrorBannerComponent } from '@components/error-banner/error-banner';
import { ExpansionCardComponent } from '@components/expansion-card/expansion-card';
import { CopyButtonComponent } from '@components/copy-button/copy-button';
import { EmptyStateComponent } from '@components/empty-state/empty-state';
import { CalloutComponent } from '@components/callout/callout';
import { CatbeeLoaderComponent } from '@ng-catbee/loader';
import { SETTINGS_PAGE_CONTEXT } from '@features/settings/services/settings-page.context';
import { formatDockerBytes } from '@utils/docker-display.utils';
import { CatbeeTooltip } from '@components/tooltip/tooltip.directive';
import { parseAppReleaseNotes, renderReleaseNotesMarkdown, ParsedReleaseNotes } from '@utils/release-notes.utils';

@Component({
  selector: 'catbee-settings-updates',
  standalone: true,
  imports: [
    CommonModule,
    ErrorBannerComponent,
    ExpansionCardComponent,
    CopyButtonComponent,
    EmptyStateComponent,
    CalloutComponent,
    CatbeeLoaderComponent,
    CatbeeTooltip
  ],
  templateUrl: './settings-updates.component.html',
  styleUrl: './settings-updates.component.scss'
})
export class SettingsUpdatesComponent {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly electronApi = inject(ElectronApiService);
  protected readonly page = inject(SETTINGS_PAGE_CONTEXT);

  protected readonly bugReportUrl =
    'https://github.com/catbee-technologies/catbee-container-studio/issues/new?template=bug_report.yml';
  protected readonly featureRequestUrl =
    'https://github.com/catbee-technologies/catbee-container-studio/issues/new?template=feature_request.yml';

  /** Map of username to failed avatar load state */
  protected failedAvatars = new Set<string>();

  protected formatDockerBytes(bytes: number): string {
    return formatDockerBytes(bytes);
  }

  protected getParsedNotes(rawMarkdown?: string): ParsedReleaseNotes {
    return parseAppReleaseNotes(rawMarkdown ?? '');
  }

  protected formatReleaseNotes(rawMarkdown?: string): SafeHtml {
    if (!rawMarkdown) return '';
    const html = renderReleaseNotesMarkdown(rawMarkdown);
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  protected isPrerelease(version: string): boolean {
    return Boolean(version && /-[0-9A-Za-z]/.test(version));
  }

  protected getContributorAvatarUrl(username: string): string {
    return `https://github.com/${username}.png?size=480`;
  }

  protected onAvatarError(username: string): void {
    this.failedAvatars.add(username);
  }

  protected hasAvatarFailed(username: string): boolean {
    return this.failedAvatars.has(username);
  }

  /**
   * Event delegation to open external links using ElectronApiService without target="_blank"
   * (mirrors logs-tab implementation).
   */
  protected onReleaseNotesClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const link = target.closest<HTMLAnchorElement>('a.notes-link, a[data-url]');
    if (!link) return;

    event.preventDefault();
    event.stopPropagation();

    const url = link.dataset['url'] || link.getAttribute('href');
    if (url) {
      void this.electronApi.openExternalUrl(url);
    }
  }

  protected openUrl(url: string, event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (url) {
      void this.electronApi.openExternalUrl(url);
    }
  }

  protected openContributorProfile(username: string, event?: Event): void {
    this.openUrl(`https://github.com/${username}`, event);
  }
}
