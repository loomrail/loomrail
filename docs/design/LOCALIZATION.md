# Localization contract

Loomrail ships its product interface in English (`en`) and Russian (`ru`). Both locales are part of the product
baseline rather than an optional follow-up.

## Runtime behavior

- The first visit follows the browser language: Russian browser locales use `ru`; every other locale falls back to
  `en`.
- The language switcher is available in the sidebar footer.
- The selected locale is saved locally and restored on the next launch.
- Loomrail updates the document `lang` attribute whenever the locale changes.
- Project names, task titles, descriptions, acceptance criteria, and other user-authored content are never translated.

## Engineering rules

- Product copy in `apps/web` must use the typed dictionary in `apps/web/src/i18n.tsx`.
- English is the key source. The Russian dictionary must satisfy the complete English key set at compile time.
- Shared UI primitives accept localized labels or message objects from the product layer; they do not import the web
  application dictionary.
- Interpolated messages use named placeholders such as `{project}` and `{state}`.
- Changes to either locale require type checking, unit tests, and a browser pass in both languages.

The public README stays in English while Loomrail is pre-alpha. A separate Russian project guide can be added when the
distribution and contributor workflow stabilize.
