// Supabase Auth Module for Uprise Remodeling Dashboard
const SUPABASE_URL = 'https://pmxrjlxfppjpwnrpqmjj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBteHJqbHhmcHBqcHducnBxbWpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwNzcyNDAsImV4cCI6MjA5MTY1MzI0MH0.Ofkobro4FpQ87fLrJFMyv461zosc22OqIT-p_QkTnWE';

// Lightweight Supabase client (no SDK dependency)
const supabase = {
  async fetch(endpoint, options = {}) {
    const token = localStorage.getItem('sb_access_token');
    const headers = {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(`${SUPABASE_URL}${endpoint}`, { ...options, headers });
    return res;
  },

  auth: {
    async signIn(email, password) {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_description || data.msg || 'Login failed');
      localStorage.setItem('sb_access_token', data.access_token);
      localStorage.setItem('sb_refresh_token', data.refresh_token);
      localStorage.setItem('sb_user', JSON.stringify(data.user));
      return data;
    },

    async signOut() {
      const token = localStorage.getItem('sb_access_token');
      if (token) {
        await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }).catch(() => {});
      }
      localStorage.removeItem('sb_access_token');
      localStorage.removeItem('sb_refresh_token');
      localStorage.removeItem('sb_user');
      window.location.href = '/admin/login.html';
    },

    async resetPassword(email) {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error_description || 'Reset failed');
      }
    },

    getUser() {
      const user = localStorage.getItem('sb_user');
      return user ? JSON.parse(user) : null;
    },

    getToken() {
      return localStorage.getItem('sb_access_token');
    },

    isLoggedIn() {
      return !!localStorage.getItem('sb_access_token');
    },
  },

  // Simple REST client for Supabase PostgREST
  async from(table) {
    const token = localStorage.getItem('sb_access_token') || SUPABASE_ANON_KEY;
    const baseUrl = `${SUPABASE_URL}/rest/v1/${table}`;
    const headers = {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };

    return {
      async select(query = '*', options = {}) {
        let url = `${baseUrl}?select=${encodeURIComponent(query)}`;
        if (options.filter) url += `&${options.filter}`;
        if (options.order) url += `&order=${options.order}`;
        if (options.limit) url += `&limit=${options.limit}`;
        const res = await fetch(url, { headers });
        return res.json();
      },

      async insert(data) {
        const res = await fetch(baseUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        });
        return res.json();
      },

      async update(data, filter) {
        const res = await fetch(`${baseUrl}?${filter}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(data),
        });
        return res.json();
      },

      async delete(filter) {
        const res = await fetch(`${baseUrl}?${filter}`, {
          method: 'DELETE',
          headers,
        });
        return res.ok;
      },
    };
  },
};

// Make supabase available globally
window.supabase = supabase;

// ---- Login Page Logic ----
const loginForm = document.getElementById('login-form');
const forgotForm = document.getElementById('forgot-form');
const forgotLink = document.getElementById('forgot-password-link');
const backToLogin = document.getElementById('back-to-login');
const logoutBtn = document.getElementById('logout-btn');

// Redirect if already logged in (on login page)
if (loginForm && supabase.auth.isLoggedIn()) {
  window.location.href = '/admin/';
}

// Redirect to login if not logged in (on dashboard)
if (!loginForm && !supabase.auth.isLoggedIn()) {
  window.location.href = '/admin/login.html';
}

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');

    btn.textContent = 'Signing in...';
    btn.disabled = true;
    errorEl.hidden = true;

    try {
      await supabase.auth.signIn(email, password);
      window.location.href = '/admin/';
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      btn.textContent = 'Sign In';
      btn.disabled = false;
    }
  });
}

if (forgotLink) {
  forgotLink.addEventListener('click', (e) => {
    e.preventDefault();
    loginForm.hidden = true;
    document.getElementById('forgot-form-container').hidden = false;
  });
}

if (backToLogin) {
  backToLogin.addEventListener('click', (e) => {
    e.preventDefault();
    loginForm.hidden = false;
    document.getElementById('forgot-form-container').hidden = true;
  });
}

if (forgotForm) {
  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('reset-email').value;
    const msgEl = document.getElementById('reset-message');
    try {
      await supabase.auth.resetPassword(email);
      msgEl.textContent = 'Check your email for a reset link.';
      msgEl.hidden = false;
      msgEl.className = 'success-message';
    } catch (err) {
      msgEl.textContent = err.message;
      msgEl.hidden = false;
      msgEl.className = 'error-message';
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => supabase.auth.signOut());
}

// Auto-logout after 30 min of inactivity
let inactivityTimer;
function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    if (supabase.auth.isLoggedIn()) {
      supabase.auth.signOut();
    }
  }, 30 * 60 * 1000);
}

if (supabase.auth.isLoggedIn()) {
  ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => {
    document.addEventListener(evt, resetInactivityTimer, { passive: true });
  });
  resetInactivityTimer();
}

export { supabase };
