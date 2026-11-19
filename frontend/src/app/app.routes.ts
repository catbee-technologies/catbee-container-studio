import { CanDeactivateFn, Routes } from '@angular/router';
import { containerDetailsResolver } from '@docker-containers/container-details/container-details.resolver';
import { imageDetailsResolver } from '@docker-images/image-details/image-details.resolver';
import { networkDetailsResolver } from '@docker-networks/network-details/network-details.resolver';
import { volumeDetailsResolver } from '@docker-volumes/volume-details/volume-details.resolver';

const confirmPendingChanges: CanDeactivateFn<{ canDeactivate(): boolean | Promise<boolean> }> = component =>
  component.canDeactivate();

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'containers'
  },
  {
    path: 'containers',
    loadComponent: () => import('@docker-containers/containers-list/containers-list').then(m => m.ContainersPage)
  },
  {
    path: 'logs',
    loadComponent: () => import('@features/logs/logs-page/logs-page').then(m => m.LogsPage)
  },
  {
    path: 'containers/:id',
    canDeactivate: [confirmPendingChanges],
    runGuardsAndResolvers: 'always',
    resolve: {
      preloadedContainerDetails: containerDetailsResolver
    },
    loadComponent: () =>
      import('@docker-containers/container-details/container-details').then(m => m.ContainerDetailsPage)
  },
  {
    path: 'images',
    canDeactivate: [confirmPendingChanges],
    loadComponent: () => import('@docker-images/images-list/images-list').then(m => m.ImagesPage)
  },
  {
    path: 'images/:id',
    canDeactivate: [confirmPendingChanges],
    runGuardsAndResolvers: 'always',
    resolve: {
      preloadedImageDetails: imageDetailsResolver
    },
    loadComponent: () => import('@docker-images/image-details/image-details').then(m => m.ImageDetailsPage)
  },
  {
    path: 'volumes',
    canDeactivate: [confirmPendingChanges],
    loadComponent: () => import('@docker-volumes/volumes-list/volumes-list').then(m => m.VolumesPage)
  },
  {
    path: 'volumes/:name',
    runGuardsAndResolvers: 'always',
    resolve: {
      preloadedVolumeDetails: volumeDetailsResolver
    },
    loadComponent: () => import('@docker-volumes/volume-details/volume-details').then(m => m.VolumeDetailsPage)
  },
  {
    path: 'networks',
    canDeactivate: [confirmPendingChanges],
    loadComponent: () => import('@docker-networks/networks-list/networks-list').then(m => m.NetworksPage)
  },
  {
    path: 'networks/:id',
    runGuardsAndResolvers: 'always',
    resolve: {
      preloadedNetworkDetails: networkDetailsResolver
    },
    loadComponent: () => import('@docker-networks/network-details/network-details').then(m => m.NetworkDetailsPage)
  },
  {
    path: 'settings',
    canDeactivate: [confirmPendingChanges],
    loadComponent: () => import('./features/settings/settings-page/settings-page').then(m => m.SettingsPageComponent)
  }
];
