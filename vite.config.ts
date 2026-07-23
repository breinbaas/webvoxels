import { defineConfig } from 'vite';

export default defineConfig({  
  base: '/webvoxels/',
  preview: {
    allowedHosts: [
      'app.breinbaas.nl',
      'apps.breinbaas.nl',
      'localhost'
    ]
  },
  server: {
    allowedHosts: [
      'app.breinbaas.nl',
      'apps.breinbaas.nl',
      'localhost'
    ]
  }
});