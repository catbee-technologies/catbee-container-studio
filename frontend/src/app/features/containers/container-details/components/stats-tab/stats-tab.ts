import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild
} from '@angular/core';
import {
  CategoryScale,
  Chart,
  Filler,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip
} from 'chart.js';
import { DockerApiService } from '@core/docker-api.service';
import { DockerContainerStats, DockerStreamEventEnvelope } from '@shared/types/docker-api.types';
import { formatDockerBytes } from '@utils/docker-display.utils';
import { EmptyStateComponent } from '@components/empty-state/empty-state';

Chart.register(CategoryScale, LinearScale, LineController, LineElement, PointElement, Filler, Tooltip);

interface StatsSample {
  label: string;
  cpuPct: number;
  memPct: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
}

const HISTORY_SIZE = 60;
const CHART_OPTS = {
  animation: false as const,
  responsive: true,
  maintainAspectRatio: false,
  interaction: { intersect: false, mode: 'index' as const },
  plugins: {
    legend: { display: false },
    tooltip: {
      enabled: true
    }
  },
  scales: {
    x: {
      display: false,
      grid: { display: false }
    },
    y: {
      display: true,
      border: { display: false },
      ticks: { color: '#6fa0bf', font: { size: 11 } },
      grid: { color: 'rgb(90 130 165 / 0.14)' }
    }
  }
};

@Component({
  selector: 'catbee-container-studio-container-stats-tab',
  imports: [CommonModule, EmptyStateComponent],
  templateUrl: './stats-tab.html',
  styleUrl: './stats-tab.scss'
})
export class StatsTabComponent implements AfterViewInit, OnDestroy {
  private static readonly STREAM_RECONNECT_MS = 2000;

  private readonly dockerApi = inject(DockerApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);
  private readonly hostRef = inject(ElementRef<HTMLElement>);

  private readonly cpuCanvas = viewChild<ElementRef<HTMLCanvasElement>>('cpuCanvas');
  private readonly memCanvas = viewChild<ElementRef<HTMLCanvasElement>>('memCanvas');
  private readonly netCanvas = viewChild<ElementRef<HTMLCanvasElement>>('netCanvas');
  private readonly blkCanvas = viewChild<ElementRef<HTMLCanvasElement>>('blkCanvas');

  readonly containerId = input.required<string>();

  readonly statsUpdate = output<DockerContainerStats>();
  readonly unavailable = output<void>();
  readonly streamError = output<string>();

  readonly history = signal<StatsSample[]>([]);
  readonly isLoading = signal(true);

  readonly latest = computed(() => {
    const h = this.history();
    return h.length > 0 ? h[h.length - 1] : null;
  });

  private readonly statsStreamId = signal<string | null>(null);
  private currentContainerId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hostResizeObserver: ResizeObserver | null = null;
  private isDisposed = false;
  private cpuChart: Chart | null = null;
  private memChart: Chart | null = null;
  private netChart: Chart | null = null;
  private blkChart: Chart | null = null;
  private chartsReady = false;

  constructor() {
    const unsub = this.dockerApi.onStreamEvent(event => this.onStreamEvent(event));
    this.destroyRef.onDestroy(() => {
      this.isDisposed = true;
      unsub();
      this.clearReconnectTimer();
      void this.stopStream();
    });

    effect(() => {
      const id = this.containerId();
      if (!id) return;
      queueMicrotask(() => void this.bindContainer(id));
    });

    effect(() => {
      const h = this.history();
      if (!this.chartsReady || h.length === 0) return;
      this.zone.runOutsideAngular(() => this.updateCharts(h));
    });
  }

  ngAfterViewInit(): void {
    this.initCharts();
  }

  formatBytes(value: number): string {
    return formatDockerBytes(value, 1);
  }

  private async bindContainer(id: string): Promise<void> {
    if (this.currentContainerId === id) return;
    this.currentContainerId = id;
    this.history.set([]);
    this.isLoading.set(true);
    this.clearReconnectTimer();
    await this.stopStream();
    await this.startStream(id);
  }

  private async startStream(id: string): Promise<void> {
    if (this.statsStreamId()) return;
    try {
      const result = await this.dockerApi.startStatsStream(id);
      this.statsStreamId.set(result.streamId);
    } catch {
      this.scheduleReconnect();
    }
  }

  private async stopStream(): Promise<void> {
    const streamId = this.statsStreamId();
    this.statsStreamId.set(null);
    if (streamId) {
      await this.dockerApi.stopStream(streamId).catch(() => undefined);
    }
  }

  private scheduleReconnect(): void {
    if (this.isDisposed || this.statsStreamId()) return;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      const id = this.currentContainerId;
      if (id) void this.startStream(id);
    }, StatsTabComponent.STREAM_RECONNECT_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private onStreamEvent(event: DockerStreamEventEnvelope): void {
    if (event.kind !== 'stats' || event.streamId !== this.statsStreamId()) return;

    if (event.type === 'error') {
      this.isLoading.set(false);
      const msg = event.error ?? 'Stats stream error.';
      if (/no such container|not found|removed/i.test(msg)) {
        this.unavailable.emit();
      } else {
        this.streamError.emit(msg);
      }
      this.statsStreamId.set(null);
      this.scheduleReconnect();
      return;
    }

    if (event.type === 'end') {
      this.isLoading.set(false);
      this.statsStreamId.set(null);
      this.scheduleReconnect();
      return;
    }

    if (event.type !== 'data' || !event.data || typeof event.data !== 'object') return;

    const raw = event.data as DockerContainerStats;
    this.zone.run(() => {
      this.isLoading.set(false);
      this.statsUpdate.emit(raw);
      this.pushSample(raw);
    });
  }

  private pushSample(raw: DockerContainerStats): void {
    const cpuDelta = (raw.cpu_stats?.cpu_usage?.total_usage ?? 0) - (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const sysDelta = (raw.cpu_stats?.system_cpu_usage ?? 0) - (raw.precpu_stats?.system_cpu_usage ?? 0);
    const onlineCpus = raw.cpu_stats?.online_cpus ?? raw.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
    const cpuPct = cpuDelta > 0 && sysDelta > 0 ? (cpuDelta / sysDelta) * onlineCpus * 100 : 0;

    const memUsage = raw.memory_stats?.usage ?? 0;
    const memLimit = raw.memory_stats?.limit ?? 0;
    const memPct = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;

    let netRx = 0;
    let netTx = 0;
    for (const iface of Object.values(
      (raw.networks ?? {}) as Record<string, { rx_bytes?: number; tx_bytes?: number }>
    )) {
      netRx += iface.rx_bytes ?? 0;
      netTx += iface.tx_bytes ?? 0;
    }

    const blkRead = this.sumBlk(raw.blkio_stats?.io_service_bytes_recursive, 'Read');
    const blkWrite = this.sumBlk(raw.blkio_stats?.io_service_bytes_recursive, 'Write');

    const label = new Date(raw.read).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    this.history.update(h => {
      const next = [...h, { label, cpuPct, memPct, memUsage, memLimit, netRx, netTx, blkRead, blkWrite }];
      return next.length > HISTORY_SIZE ? next.slice(next.length - HISTORY_SIZE) : next;
    });
  }

  private sumBlk(items: { op?: string; value?: number }[] | undefined, op: string): number {
    if (!items || items.length === 0) return 0;
    return items.filter(i => i.op?.toLowerCase() === op.toLowerCase()).reduce((acc, i) => acc + (i.value ?? 0), 0);
  }

  private initCharts(): void {
    const cpuEl = this.cpuCanvas()?.nativeElement;
    const memEl = this.memCanvas()?.nativeElement;
    const netEl = this.netCanvas()?.nativeElement;
    const blkEl = this.blkCanvas()?.nativeElement;
    if (!cpuEl || !memEl || !netEl || !blkEl) return;

    const baseDataset = (color: string, fill: string) => ({
      data: [] as number[],
      borderColor: color,
      backgroundColor: fill,
      borderWidth: 1.5,
      pointRadius: 0,
      pointHitRadius: 8,
      tension: 0.3,
      fill: true
    });

    this.cpuChart = new Chart(cpuEl, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{ ...baseDataset('#56d364', 'rgb(86 211 100 / 0.10)'), label: 'CPU %' }]
      },
      options: {
        ...CHART_OPTS,
        scales: {
          ...CHART_OPTS.scales,
          y: {
            ...CHART_OPTS.scales.y,
            min: 0,
            ticks: {
              ...CHART_OPTS.scales.y.ticks,
              callback: v => `${v}%`
            }
          }
        }
      }
    });

    this.memChart = new Chart(memEl, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{ ...baseDataset('#58a6ff', 'rgb(88 166 255 / 0.10)'), label: 'Memory %' }]
      },
      options: {
        ...CHART_OPTS,
        scales: {
          ...CHART_OPTS.scales,
          y: {
            ...CHART_OPTS.scales.y,
            min: 0,
            max: 100,
            ticks: { ...CHART_OPTS.scales.y.ticks, callback: v => `${v}%` }
          }
        }
      }
    });

    this.netChart = new Chart(netEl, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            ...baseDataset('#56d364', 'rgb(86 211 100 / 0.06)'),
            label: 'Rx'
          },
          {
            ...baseDataset('#e3b341', 'rgb(227 179 65 / 0.06)'),
            label: 'Tx'
          }
        ]
      },
      options: {
        ...CHART_OPTS,
        plugins: {
          ...CHART_OPTS.plugins,
          tooltip: {
            enabled: true,
            callbacks: {
              label: context => {
                const value = Number(context.raw ?? 0);
                return `${context.dataset.label}: ${formatDockerBytes(value, 1)}`;
              }
            }
          }
        },
        scales: {
          ...CHART_OPTS.scales,
          y: {
            ...CHART_OPTS.scales.y,
            ticks: {
              ...CHART_OPTS.scales.y.ticks,
              callback: value => formatDockerBytes(Number(value), 0)
            }
          }
        }
      }
    });

    this.blkChart = new Chart(blkEl, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            ...baseDataset('#58a6ff', 'rgb(88 166 255 / 0.06)'),
            label: 'Read'
          },
          {
            ...baseDataset('#bc8cff', 'rgb(188 140 255 / 0.06)'),
            label: 'Write'
          }
        ]
      },
      options: {
        ...CHART_OPTS,
        plugins: {
          ...CHART_OPTS.plugins,
          tooltip: {
            enabled: true,
            callbacks: {
              label: context => {
                const value = Number(context.raw ?? 0);
                return `${context.dataset.label}: ${formatDockerBytes(value, 1)}`;
              }
            }
          }
        },
        scales: {
          ...CHART_OPTS.scales,
          y: {
            ...CHART_OPTS.scales.y,
            ticks: {
              ...CHART_OPTS.scales.y.ticks,
              callback: value => formatDockerBytes(Number(value), 0)
            }
          }
        }
      }
    });

    this.chartsReady = true;

    // When the component transitions from display:none to visible, its canvas
    // elements get a real size. Observe host so charts are resized immediately.
    this.hostResizeObserver = new ResizeObserver(() => {
      this.zone.runOutsideAngular(() => {
        this.cpuChart?.resize();
        this.memChart?.resize();
        this.netChart?.resize();
        this.blkChart?.resize();
      });
    });
    this.hostResizeObserver.observe(this.hostRef.nativeElement);

    const h = this.history();
    if (h.length > 0) this.updateCharts(h);
  }

  private getCpuAxisMax(history: StatsSample[]): number {
    const maxCpu = Math.max(...history.map(s => s.cpuPct), 100);
    if (maxCpu <= 100) return 100;
    return Math.ceil((maxCpu * 1.1) / 100) * 100;
  }

  private updateCharts(h: StatsSample[]): void {
    const labels = h.map(s => s.label);
    if (this.cpuChart) {
      this.cpuChart.data.labels = labels;
      this.cpuChart.data.datasets[0]!.data = h.map(s => +s.cpuPct.toFixed(2));
      this.cpuChart.options.scales!['y']!.max = this.getCpuAxisMax(h);
      this.cpuChart.update('none');
    }
    if (this.memChart) {
      this.memChart.data.labels = labels;
      this.memChart.data.datasets[0]!.data = h.map(s => +s.memPct.toFixed(2));
      this.memChart.update('none');
    }
    if (this.netChart) {
      this.netChart.data.labels = labels;
      this.netChart.data.datasets[0]!.data = h.map(s => s.netRx);
      this.netChart.data.datasets[1]!.data = h.map(s => s.netTx);
      this.netChart.update('none');
    }
    if (this.blkChart) {
      this.blkChart.data.labels = labels;
      this.blkChart.data.datasets[0]!.data = h.map(s => s.blkRead);
      this.blkChart.data.datasets[1]!.data = h.map(s => s.blkWrite);
      this.blkChart.update('none');
    }
  }

  private destroyCharts(): void {
    this.cpuChart?.destroy();
    this.memChart?.destroy();
    this.netChart?.destroy();
    this.blkChart?.destroy();
    this.cpuChart = null;
    this.memChart = null;
    this.netChart = null;
    this.blkChart = null;
    this.chartsReady = false;
  }

  ngOnDestroy(): void {
    this.hostResizeObserver?.disconnect();
    this.hostResizeObserver = null;
    this.destroyCharts();
  }
}
