import './assets/css/main.css'

import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import ui from '@nuxt/ui/vue-plugin'
import App from './App.vue'
import DashboardPage from './pages/DashboardPage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: DashboardPage }],
})

const app = createApp(App)
app.use(router)
app.use(ui)
app.mount('#app')
