import axios from 'axios';
import { listCache } from './listCache.js';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api/v1',
  withCredentials: true,
});

api.interceptors.response.use(
  (response) => {
    if (String(response.config?.method || 'get').toLowerCase() !== 'get') listCache.clear();
    return response;
  },
  (error) => {
    if (error.response?.status === 401) listCache.clear();
    return Promise.reject(error);
  },
);

export default api;
