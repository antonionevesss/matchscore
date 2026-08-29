# Changelog

All notable changes to Matchday Control are documented here.

## [1.8.1] - 2026-08-29

### Fixed

- Fixed clock synchronization between the control panel and `Clock.txt`.
- The control panel now interpolates from the server-authoritative timestamp, avoiding visible stalls and jumps between SSE updates.
- Clock start, pause, adjustment, SSE snapshots, and text output now share the same timestamp reference.

## [1.8.0] - 2026-08-29

### Added

- Reorganized the control panel into Game, Status, and Settings pages with hash navigation.
- Added an operational status dashboard for the server, output files, OBS connection and process, active scene, projector, and last checks.
- Added structured persistent logs with timestamps, categories, levels, search, filters, and export.
- Added OBS recovery controls for launch, retry, focus, preview projector, active scene feedback, and configurable scene buttons including initial music.
- Added bilingual English and Portuguese (Portugal) interface support throughout the new pages.

### Changed

- Reworked the interface with a black/graphite and gold visual system, responsive mobile layout, accessible focus states, and compact segmented navigation.
- Improved the mobile layout with compact two-column status cards and reduced redundant page headings.
- Redesigned notifications with severity styling and quick dismissal by clicking the notification, using the close button, or pressing Enter/Space.
- OBS is launched independently so closing Matchday Control does not close OBS.

### Fixed

- Prevented duplicate OBS/projector requests when an existing visible instance or window is already detected.
- Improved projector/process detection and reconnection feedback.
- Added startup diagnostics persistence for failures that occur before the server is ready.

[1.8.1]: https://github.com/antonionevesss/matchscore/releases/tag/v1.8.1
[1.8.0]: https://github.com/antonionevesss/matchscore/releases/tag/v1.8.0
