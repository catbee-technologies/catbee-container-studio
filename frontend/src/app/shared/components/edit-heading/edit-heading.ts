import { Component, input } from '@angular/core';

@Component({
  selector: 'catbee-container-studio-edit-heading',
  template: `
    <header>
      <div class="heading-title">
        <span class="mat-icon-filled" aria-hidden="true">edit</span>
        <h2>{{ title() }}</h2>
      </div>
      @if (hint()) {
        <p>
          @if (hintIcon()) {
            <span class="mat-icon-filled hint-icon" [style.color]="hintIconColor()" aria-hidden="true">
              {{ hintIcon() }}
            </span>
          }
          <span>{{ hint() }}</span>
        </p>
      }
    </header>
  `,
  styles: `
    :host {
      display: block;
      flex-shrink: 0;
    }

    header {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem 1rem;
    }

    .heading-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .heading-title > .mat-icon-filled {
      display: grid;
      place-items: center;
      flex-shrink: 0;
      width: 1.8rem;
      height: 1.8rem;
      font-size: 1rem;
      color: var(--color-primary-text);
      background: var(--bg-port);
      border: 1px solid var(--border-color-section);
      border-radius: 0.5rem;
    }

    h2 {
      margin: 0;
      color: var(--ink-100);
      font-size: 0.9rem;
      font-weight: 600;
    }

    p {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      flex: 1 1 20rem;
      margin: 0;
      color: var(--ink-300);
      font-size: var(--font-size-xs);
      line-height: 1.5;
    }

    .hint-icon {
      flex-shrink: 0;
      font-size: 1rem;
      line-height: inherit;
    }
  `,
  host: {
    '[attr.title]': 'null'
  }
})
export class EditHeadingComponent {
  readonly title = input.required<string>();
  readonly hint = input('');
  readonly hintIcon = input('lightbulb');
  readonly hintIconColor = input('var(--color-warning-text)');
}
