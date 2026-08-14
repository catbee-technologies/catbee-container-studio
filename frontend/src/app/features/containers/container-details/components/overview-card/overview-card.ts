import { CommonModule } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { PortListComponent } from '@components/port-list/port-list';
import { DockerContainerInfo, DockerContainerStats } from '@shared/types/docker-api.types';
import { formatDockerBytes } from '@utils/docker-display.utils';

@Component({
  selector: 'catbee-container-studio-container-overview-card',
  imports: [CommonModule, PortListComponent],
  templateUrl: './overview-card.html',
  styleUrl: './overview-card.scss'
})
export class OverviewCardComponent {
  readonly container = input.required<DockerContainerInfo>();
  readonly imageRef = input<string>('');
  readonly stats = input<DockerContainerStats | null>(null);
  readonly showAllPorts = input(false);

  readonly showAllPortsChange = output<boolean>();

  setShowAllPorts(expanded: boolean): void {
    this.showAllPortsChange.emit(expanded);
  }

  formatCpu(stats: DockerContainerStats | null): string {
    if (!stats) {
      return '--';
    }

    const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
    const onlineCpus = stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;

    if (cpuDelta <= 0 || systemDelta <= 0 || onlineCpus <= 0) {
      return '0.00%';
    }

    return `${((cpuDelta / systemDelta) * onlineCpus * 100).toFixed(2)}%`;
  }

  formatMemory(stats: DockerContainerStats | null): string {
    if (!stats) {
      return '--';
    }

    const usage = stats.memory_stats?.usage ?? 0;
    const limit = stats.memory_stats?.limit ?? 0;
    if (limit <= 0) {
      return `${formatDockerBytes(usage, 1)} / --`;
    }

    const pct = (usage / limit) * 100;
    return `${formatDockerBytes(usage, 1)} / ${formatDockerBytes(limit, 1)} (${pct.toFixed(1)}%)`;
  }

  formatNetwork(stats: DockerContainerStats | null): string {
    if (!stats || !stats.networks) {
      return '--';
    }

    let rx = 0;
    let tx = 0;
    const values = Object.values(stats.networks as Record<string, { rx_bytes?: number; tx_bytes?: number }>);
    for (const item of values) {
      rx += item.rx_bytes ?? 0;
      tx += item.tx_bytes ?? 0;
    }

    return `${formatDockerBytes(rx, 1)} / ${formatDockerBytes(tx, 1)}`;
  }

  formatBlockIo(stats: DockerContainerStats | null): string {
    if (!stats || !stats.blkio_stats) {
      return '--';
    }

    const readBytes = this.sumBlkIo(stats.blkio_stats.io_service_bytes_recursive, 'Read');
    const writeBytes = this.sumBlkIo(stats.blkio_stats.io_service_bytes_recursive, 'Write');
    return `${formatDockerBytes(readBytes, 1)} / ${formatDockerBytes(writeBytes, 1)}`;
  }

  private sumBlkIo(items: { op?: string; value?: number }[] | undefined, op: string): number {
    if (!items || items.length === 0) {
      return 0;
    }

    return items
      .filter(item => item.op?.toLowerCase() === op.toLowerCase())
      .reduce((acc, item) => acc + (item.value ?? 0), 0);
  }
}
