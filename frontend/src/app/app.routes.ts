import { Routes } from '@angular/router';
import { containerDetailsResolver } from '@docker-containers/container-details/container-details.resolver';
import { imageDetailsResolver } from '@docker-images/image-details/image-details.resolver';
import { volumeDetailsResolver } from '@docker-volumes/volume-details/volume-details.resolver';

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
    resolve: {
      preloadedContainerDetails: containerDetailsResolver
    },
    loadComponent: () =>
      import('@docker-containers/container-details/container-details').then(m => m.ContainerDetailsPage)
  },
  {
    path: 'images',
    loadComponent: () => import('@docker-images/images-list/images-list').then(m => m.ImagesPage)
  },
  {
    path: 'images/:id',
    resolve: {
      preloadedImageDetails: imageDetailsResolver
    },
    loadComponent: () => import('@docker-images/image-details/image-details').then(m => m.ImageDetailsPage)
  },
  {
    path: 'volumes',
    loadComponent: () => import('@docker-volumes/volumes-list/volumes-list').then(m => m.VolumesPage)
  },
  {
    path: 'volumes/:name',
    resolve: {
      preloadedVolumeDetails: volumeDetailsResolver
    },
    loadComponent: () => import('@docker-volumes/volume-details/volume-details').then(m => m.VolumeDetailsPage)
  }
];
