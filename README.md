# CatBee Container Studio

[![Build](https://github.com/catbee-technologies/catbee-container-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/catbee-technologies/catbee-container-studio/actions/workflows/ci.yml)
[![Release](https://github.com/catbee-technologies/catbee-container-studio/actions/workflows/release.yml/badge.svg)](https://github.com/catbee-technologies/catbee-container-studio/actions/workflows/release.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=catbee-technologies_catbee-container-studio&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=catbee-technologies_catbee-container-studio)
[![Latest Release](https://img.shields.io/github/v/release/catbee-technologies/catbee-container-studio)](https://github.com/catbee-technologies/catbee-container-studio/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/catbee-technologies/catbee-container-studio/total)](https://github.com/catbee-technologies/catbee-container-studio/releases)
[![License](https://img.shields.io/github/license/catbee-technologies/catbee-container-studio)](https://github.com/catbee-technologies/catbee-container-studio/blob/main/LICENSE)

**CatBee Container Studio** is a cross-platform desktop application for managing and monitoring Docker resources through a clean, native desktop interface.

Built with **Electron, TypeScript, and Angular**, CatBee Container Studio provides a focused graphical interface for working with Docker containers, images, volumes, and their files without relying exclusively on the command line.

## Download

Download the latest version from **[GitHub Releases](https://github.com/catbee-technologies/catbee-container-studio/releases/latest)**.

### Microsoft Store

CatBee Container Studio is also available directly from the **Microsoft Store** for Windows.

<a href="https://apps.microsoft.com/detail/9NX6H3J2RNX2?referrer=appbadge&mode=full" target="_blank"  rel="noopener noreferrer">
 <img src="https://get.microsoft.com/images/en-us%20dark.svg" width="200"/>
</a>

### Available Platforms

- **Windows** — `.exe`, `.zip`, and Microsoft Store
- **macOS** — `.dmg` and `.zip`
- **Linux** — `.AppImage`, `.deb`, `.rpm`, and `.tar.gz`

> See the latest GitHub Release for available installers and assets.

## Features

### Containers

- List and inspect containers
- Start, stop, and restart containers
- Delete containers
- View container logs
- Inspect container configuration
- View container statistics
- Monitor resource usage through charts
- Execute commands inside containers
- Browse files inside containers

### Run Containers

CatBee Container Studio allows containers to be created and started directly from available Docker images.

When creating a container, supported configuration options can include:

- Container name
- Docker image
- Port mappings
- Environment variables
- Volume mappings

This provides a graphical alternative to manually constructing `docker run` commands.

### Files Browser

The **Files Browser** allows you to explore files and directories inside both Docker containers and volumes directly from the application.

You can:

- Browse directories inside containers
- Browse directories inside volumes
- Navigate through container and volume paths
- View, edit, and delete files inside containers and volumes
- Explore container and volume contents without opening a terminal

This makes it easier to inspect application data, configuration files, logs, and other files stored inside containers and volumes.

### Images

- List available Docker images
- Inspect image information
- Delete images
- Use images to create and run containers

### Volumes

- List available Docker volumes
- Inspect volume information
- Delete volumes
- Browse files and directories inside volumes

## Tech Stack

| Technology | Purpose |
| --- | --- |
| **Electron** | Desktop application runtime |
| **Angular** | Frontend UI |
| **TypeScript** | Application development |
| **Dockerode** | Docker Engine API integration |
| **Pino** | Application logging |
| **Electron Builder** | Application packaging and distribution |
| **ESLint** | Code quality and linting |

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

## Project Structure

```text
catbee-container-studio/
├── frontend/                     # Angular frontend application
├── scripts/                      # Build and utility scripts
├── src/                          # Electron main-process source
│   ├── main/                     # Application entry point and desktop infrastructure
│   ├── ipc/                      # Electron IPC handlers
│   └── ...
├── electron-builder.config.mjs   # Electron Builder configuration
├── package.json
├── tsconfig.json
└── README.md
```

## Requirements

Before running CatBee Container Studio locally, make sure you have:

- Node.js
- npm
- A supported Docker runtime

Docker must be **installed, running, and accessible** on the host system.

Verify your Docker installation:

```bash
docker version
```

## Getting Started

Clone the repository:

```bash
git clone https://github.com/catbee-technologies/catbee-container-studio.git
cd catbee-container-studio
```

Install the root dependencies:

```bash
npm install
```

Install the frontend dependencies:

```bash
cd frontend
npm install
cd ..
```

## Development

Start the Angular development server and Electron application together:

```bash
npm run app:serve
```

The Angular development server runs on:

```text
http://localhost:4281
```

The Electron application waits for the Angular development server to become available and then opens the desktop application automatically.

### TypeScript

Build the Electron TypeScript source:

```bash
npm run build
```

Watch TypeScript files for changes:

```bash
npm run build:watch
```

### Frontend

Build the Angular frontend:

```bash
npm run build:ui
```

## Linting

Lint the Electron application:

```bash
npm run lint
```

Automatically fix Electron lint issues:

```bash
npm run lint:fix
```

Lint the Angular frontend:

```bash
npm run lint:ui
```

Automatically fix Angular lint issues:

```bash
npm run lint:ui:fix
```

## Production Builds

Build artifacts are generated according to the Electron Builder configuration. Desktop installers are published as GitHub Release assets through the release workflow, while the Windows Microsoft Store package is published separately.

Build the complete application:

```bash
npm run package
```

Create a distributable for the current platform:

```bash
npm run dist
```

### Windows

```bash
npm run dist:win
```

### macOS

```bash
npm run dist:mac
```

### Linux

```bash
npm run dist:linux
```

## Docker Integration

CatBee Container Studio communicates with the Docker Engine through **Dockerode**.

The application provides a graphical interface for managing and monitoring Docker resources.

Docker must be running before using Docker management and monitoring functionality within the application.

## Supported Platforms

CatBee Container Studio is designed as a cross-platform desktop application for:

- **Windows** — Installer and Microsoft Store
- **macOS**
- **Linux**

Docker must be available through a supported Docker runtime on the host system.

## Project Status

CatBee Container Studio is currently under active development.

The project is evolving toward a complete desktop experience for managing and monitoring Docker resources, with additional container, image, volume, file browser, and Docker Engine capabilities being developed over time.

## License

MIT © Catbee Technologies

See the [`LICENSE`](LICENSE) file included in the repository for the full license text.
