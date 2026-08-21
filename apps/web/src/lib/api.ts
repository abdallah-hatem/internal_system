import axios from 'axios';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

export const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor: attach token
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// Response interceptor: handle 401
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('token');
      localStorage.removeItem('user');

      // Keep the locale the user is actually in. This was hardcoded to
      // /en/login, and because a signed-out page fires queries that 401, this
      // hard navigation overrode the route guard's correct destination — an
      // Arabic session was thrown to the English login page no matter what the
      // guard did.
      const [, maybeLocale] = window.location.pathname.split('/');
      const locale = ['en', 'ar'].includes(maybeLocale) ? maybeLocale : 'en';
      const target = `/${locale}/login`;

      // Already there: replacing again would loop while the queries settle.
      if (window.location.pathname !== target) {
        window.location.replace(target);
      }
    }
    return Promise.reject(error);
  }
);

// Auth API
export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  register: (data: { email: string; password: string; displayName: string; role: string }) =>
    api.post('/auth/register', data),
  getProfile: () => api.get('/auth/profile'),
};

// Generic CRUD helpers
export const createCrudApi = <T>(endpoint: string) => ({
  list: (params?: Record<string, any>) => api.get(`/${endpoint}`, { params }),
  getById: (id: string) => api.get(`/${endpoint}/${id}`),
  create: (data: Partial<T>) => api.post(`/${endpoint}`, data),
  update: (id: string, data: Partial<T>) => api.put(`/${endpoint}/${id}`, data),
  delete: (id: string) => api.delete(`/${endpoint}/${id}`),
});
