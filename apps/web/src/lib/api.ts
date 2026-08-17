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
      window.location.href = '/en/login';
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
