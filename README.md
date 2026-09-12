# CatBee Container Studio

[![Build](https://github.com/catbee-technologies/catbee-container-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/catbee-technologies/catbee-container-studio/actions/workflows/ci.yml)
[![Release](https://github.com/catbee-technologies/catbee-container-studio/actions/workflows/release.yml/badge.svg)](https://github.com/catbee-technologies/catbee-container-studio/actions/workflows/release.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=catbee-technologies_catbee-container-studio&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=catbee-technologies_catbee-container-studio)
[![Latest Release](https://img.shields.io/github/v/release/catbee-technologies/catbee-container-studio)](https://github.com/catbee-technologies/catbee-container-studio/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/catbee-technologies/catbee-container-studio/total)](https://github.com/catbee-technologies/catbee-container-studio/releases)
[![License](https://img.shields.io/github/license/catbee-technologies/catbee-container-studio)](https://github.com/catbee-technologies/catbee-container-studio/blob/main/LICENSE)

**CatBee Container Studio** is a cross-platform desktop application for managing and monitoring Docker resources through a clean, native desktop interface.

Built with **Electron, TypeScript, and Angular**, CatBee Container Studio provides a focused graphical interface for working with Docker containers, images, volumes, networks, logs, and files without relying exclusively on the command line.

---

## Download

Download the latest version from **[GitHub Releases](https://github.com/catbee-technologies/catbee-container-studio/releases/latest)**.

### Microsoft Store

CatBee Container Studio is also available directly from the **Microsoft Store** for Windows:

<a href="https://apps.microsoft.com/detail/9NX6H3J2RNX2?referrer=appbadge&mode=full" target="_blank" rel="noopener noreferrer">
  <img src="https://get.microsoft.com/images/en-us%20dark.svg" width="200" alt="Download from Microsoft Store"/>
</a>

### Supported Platforms

- **Windows** — `.exe` installer, portable `.zip`, and Microsoft Store (`.msix`)
- **macOS** — `.dmg` disk image and `.zip` (Intel and Apple Silicon)
- **Linux** — `.AppImage`, `.deb`, `.rpm`, and `.tar.gz`

> See the latest GitHub Release for available installers and assets.

---

## Features

### Containers

- **Lifecycle Management**: Start, stop, restart, pause, unpause, and delete containers individually or in bulk.
- **Docker Compose Grouping**: Automatically group containers by Compose project with collective status summaries.
- **Aggregate Group Metrics**: Live CPU, Memory, Disk I/O, and Network I/O metrics summarized across all containers in each Compose group.
- **Group Actions**: Coordinated start, stop, restart, pause, unpause, and delete operations across entire Compose projects.
- **Search & Filtering**: Filter containers by name, ID, or image, with a quick toggle for running containers.
- **Status & Health**: Visual indicators for container state, health status (healthy, unhealthy, starting), and compact uptimes.
- **Container Details & Inspection**:
  - **Overview**: Inspect container ID, image, created date, ports, commands, and entrypoint.
  - **Metrics & Charts**: Real-time streaming charts for CPU, Memory usage with limit thresholds, Network I/O, and Block I/O.
  - **Streaming Logs**: Live container log output with virtualized scrolling, keyword/regex search, case matching, timestamps toggle, and auto-scroll.
  - **Interactive Terminal**: Built-in shell powered by **xterm.js** with full TTY emulation and terminal search.
  - **Files Browser**: Explore the container filesystem; view, edit with **Monaco Editor**, and delete files.
  - **Environment Variables**: Inspect container environment variables with instant copy actions.
  - **Mounts**: View bound host paths and named volumes with read/write permissions.
  - **Raw JSON**: Inspect full Docker container configuration with syntax highlighting.

### Run Containers

CatBee Container Studio allows containers to be created and started directly from available Docker images.

When creating a container, supported configuration options include:

- Container name (optional)
- Port mappings (host port to container port)
- Volume mappings (host path picker, container path, and read-only toggle)
- Environment variables (key-value pairs, with direct `.env` file paste support)

This provides a graphical alternative to manually constructing `docker run` commands.

### Files Browser

The **Files Browser** allows you to explore files and directories inside both Docker containers and volumes directly from the application.

You can:

- Browse directories inside containers and volumes
- Navigate paths with breadcrumbs
- View and preview file contents
- Edit and save files in-app using the integrated **Monaco Editor**
- Delete files and directories
- Sort entries by name, size, permissions, and modified date

This makes it easier to inspect application data, configuration files, logs, and other files stored inside containers and volumes without opening a terminal.

### Images

- List available Docker images with tags, size, and creation dates
- Pull images from Docker registries
- Inspect image information, layers history, and containers in use
- Delete individual images or bulk delete selected images
- Prune dangling images
- Run containers directly from any image

### Volumes

- List available Docker volumes with total size calculation
- Filter volumes by usage (All, In Use, Unused)
- Inspect volume details, driver, mountpoint, and containers in use
- Browse, view, edit, and delete files inside volumes via the Files Browser
- Delete volumes individually or in bulk
- Prune unused volumes

### Networks

- List available Docker networks
- Filter networks by usage (All, In Use, Unused)
- Inspect network settings (driver, scope, IPv6, internal, attachable, ingress)
- Inspect IPAM configuration (subnet, gateway, IP range)
- View connected containers with assigned IP addresses and MAC addresses
- Create custom networks
- Delete individual networks, delete selected networks, and prune unused networks

### Logs Hub

- Centralized multi-container log aggregation page
- Select and filter containers to stream logs concurrently
- Color-coded container indicators
- Advanced search with case sensitivity, whole word, regex, and match isolation
- High-performance virtualized scrolling through large log buffers
- Auto-scroll / follow toggle, timestamps toggle, and log clearing

### Themes

- Curated **Dark Theme** and **Light Theme** with instant switching.

---

## Tech Stack

| Technology | Purpose |
| --- | --- |
| **Electron** | Cross-platform desktop runtime |
| **Angular** | Modern component-driven frontend with Signals & Control Flow |
| **TypeScript** | End-to-end typed development |
| **Dockerode** | Docker Engine API integration over local/named pipes and sockets |
| **Monaco Editor** | Integrated code and file editor with syntax highlighting |
| **xterm.js** | Interactive terminal emulation for container shells |
| **Chart.js** | Real-time interactive resource monitoring graphs |
| **TanStack Virtual** | High-performance virtualized log scrolling |
| **Pino** | Structured high-performance desktop application logging |
| **Electron Builder** | Multi-target packaging, distribution, and auto-updater |
| **ESLint & Prettier** | Code quality, consistency, and automated formatting |

---

## Architecture

CatBee Container Studio uses a layered desktop architecture where the Angular renderer communicates with the Electron main process through IPC.

```text
┌──────────────────────────────────────────────┐
│                  Angular UI                  │
│                                              │
│   Containers  │  Images  │  Volumes  │ ...   │
└──────────────────────┬───────────────────────┘
                       │
                  Electron IPC
                       │
┌──────────────────────▼───────────────────────┐
│             Electron Main Process            │
│                                              │
│       IPC  │  Runtime  │  Window  │  Logs    │
└──────────────────────┬───────────────────────┘
                       │
                    Dockerode
                       │
┌──────────────────────▼───────────────────────┐
│                Docker Engine                 │
│                                              │
│   Containers  │  Images  │  Volumes  │ ...   │
└──────────────────────────────────────────────┘
```

The Angular frontend is responsible for the user interface, while the Electron main process handles Docker and other system-level operations.

Docker communication is performed through **Dockerode**, keeping Docker access outside the renderer process.

---

## Project Structure

```text
catbee-container-studio/
├── frontend/                     # Angular frontend application
│   ├── src/
│   │   ├── app/
│   │   │   ├── features/         # Domain feature pages
│   │   │   │   ├── containers/   # Container list, details, stats, shell, files
│   │   │   │   ├── images/       # Image repository & inspection
│   │   │   │   ├── logs/         # Centralized multi-container log hub
│   │   │   │   ├── networks/     # Network list, details, connected containers
│   │   │   │   └── volumes/      # Volume list & volume file browser
│   │   │   └── shared/           # Reusable UI components, dialogs, pipes, utils
│   │   └── styles/               # Global SCSS themes, design tokens, mixins
│   ├── package.json
│   └── tsconfig.json
├── src/                          # Electron main process source
│   ├── ipc/                      # IPC channel contracts & domain handlers
│   │   ├── docker/               # Containers, images, networks, volumes, streams
│   │   └── app/                  # Window, platform, shell, updater handlers
│   ├── main/                     # App lifecycle, window management, logger
│   └── preload.ts                # Context bridge exposing typed API to renderer
├── scripts/                      # Build, logo generation, and release automation
├── electron-builder.config.mjs   # Electron Builder distribution config
├── package.json
├── tsconfig.json
└── README.md
```

---

## Prerequisites

Before running CatBee Container Studio locally, ensure you have:

- **Node.js** (v22 or newer recommended)
- **npm** (v10 or newer)
- **Docker Engine** / **Docker Desktop** installed, running, and accessible on your host machine

Verify your Docker daemon is accessible:

```bash
docker version
```

---

## Getting Started

1. **Clone the repository**:
   ```bash
   git clone https://github.com/catbee-technologies/catbee-container-studio.git
   cd catbee-container-studio
   ```

2. **Install root dependencies**:
   ```bash
   npm install
   ```

3. **Install frontend dependencies**:
   ```bash
   cd frontend
   npm install
   cd ..
   ```

---

## Development

Start the Angular development server and Electron desktop application concurrently:

```bash
npm run app:serve
```

- The Angular dev server launches at `http://localhost:4281`.
- Electron automatically waits for the dev server and launches the desktop window with hot reloading.

### Individual Build Tasks

- **Watch Electron main process TypeScript**:
  ```bash
  npm run build:watch
  ```

- **Build Angular frontend**:
  ```bash
  npm run build:ui
  ```

- **Build Electron main process**:
  ```bash
  npm run build
  ```

---

## Code Quality & Linting

- **Lint Electron main process**:
  ```bash
  npm run lint
  npm run lint:fix
  ```

- **Lint Angular frontend**:
  ```bash
  npm run lint:ui
  npm run lint:ui:fix
  ```

- **Format frontend code with Prettier**:
  ```bash
  cd frontend && npm run format
  ```

---

## Production Builds & Packaging

To compile both frontend and main process bundles:

```bash
npm run package
```

To create platform-specific distributables:

```bash
# Current platform
npm run dist

# Windows (.exe installer)
npm run dist:win

# Windows Store package (.msix)
npm run dist:win:store

# macOS (.dmg and .zip)
npm run dist:mac

# Linux (.AppImage, .deb, .rpm, .tar.gz)
npm run dist:linux
```

All generated distributables are output to the `build/` directory.

---

## License

MIT © Catbee Technologies

See the [`LICENSE`](LICENSE) file included in the repository for the full license text.
