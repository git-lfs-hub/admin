import { VueQueryPlugin } from '@tanstack/vue-query';
import { createApp } from 'vue';

import 'vue-sonner/style.css';

import App from './App.vue';
import router from './router';

import './style.css';

createApp(App).use(router).use(VueQueryPlugin).mount('#app');
