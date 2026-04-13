// Dashboard main logic — routing, data loading, UI interactions
const { supabase } = await import('./auth.js');

// ---- Section Routing ----
const navItems = document.querySelectorAll('.nav-item[data-section]');
const sections = document.querySelectorAll('.dashboard-section');
const pageTitle = document.getElementById('page-title');

function showSection(sectionId) {
  sections.forEach(s => s.classList.remove('active'));
  navItems.forEach(n => n.classList.remove('active'));

  const target = document.getElementById(`section-${sectionId}`);
  const nav = document.querySelector(`.nav-item[data-section="${sectionId}"]`);

  if (target) target.classList.add('active');
  if (nav) nav.classList.add('active');

  const titles = {
    overview: 'Overview',
    content: 'Content Editor',
    blog: 'Blog Manager',
    media: 'Media Library',
    leads: 'Lead Management',
    reviews: 'Review Manager',
    analytics: 'Analytics',
    calendar: 'Content Calendar',
    approval: 'Approval Queue',
    platforms: 'Connected Platforms',
    settings: 'Settings',
    users: 'User Management',
  };
  pageTitle.textContent = titles[sectionId] || 'Dashboard';

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
}

navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    showSection(item.dataset.section);
  });
});

// Mobile menu toggle
document.getElementById('menu-toggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// ---- Load User Info ----
const user = supabase.auth.getUser();
if (user) {
  document.getElementById('user-name').textContent = user.email || 'User';
}

// ---- Settings Tabs ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---- Modal ----
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalClose = document.getElementById('modal-close');

function openModal(title, content) {
  modalTitle.textContent = title;
  if (typeof content === 'string') {
    modalBody.innerHTML = content;
  } else {
    modalBody.innerHTML = '';
    modalBody.appendChild(content);
  }
  modalOverlay.hidden = false;
}

function closeModal() {
  modalOverlay.hidden = true;
  modalBody.innerHTML = '';
}

modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// ---- Load Dashboard Data ----
async function loadOverviewStats() {
  try {
    const leadsTable = await supabase.from('leads');
    const leads = await leadsTable.select('id', { filter: 'status=eq.new' });
    document.getElementById('stat-leads').textContent = Array.isArray(leads) ? leads.length : 0;

    const postsTable = await supabase.from('blog_posts');
    const posts = await postsTable.select('id');
    document.getElementById('stat-posts').textContent = Array.isArray(posts) ? posts.length : 0;

    const reviewsTable = await supabase.from('reviews');
    const reviews = await reviewsTable.select('id');
    document.getElementById('stat-reviews').textContent = Array.isArray(reviews) ? reviews.length : 0;
  } catch (err) {
    console.error('Error loading stats:', err);
  }
}

async function loadLeads() {
  try {
    const table = await supabase.from('leads');
    const leads = await table.select('*', { order: 'submitted_at.desc', limit: 50 });
    const tbody = document.getElementById('leads-tbody');

    if (!Array.isArray(leads) || leads.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No leads yet.</td></tr>';
      return;
    }

    tbody.innerHTML = leads.map(lead => `
      <tr>
        <td>${escapeHtml(lead.name || '—')}</td>
        <td>${escapeHtml(lead.email || '—')}</td>
        <td>${escapeHtml(lead.phone || '—')}</td>
        <td>${escapeHtml(lead.form_source || '—')}</td>
        <td><span class="status-badge status-${lead.status === 'new' ? 'pending' : lead.status === 'converted' ? 'up' : 'disconnected'}">${lead.status}</span></td>
        <td>${lead.submitted_at ? new Date(lead.submitted_at).toLocaleDateString() : '—'}</td>
        <td><button class="btn-secondary" onclick="updateLeadStatus('${lead.id}')">Update</button></td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Error loading leads:', err);
  }
}

async function loadBlogPosts() {
  try {
    const table = await supabase.from('blog_posts');
    const posts = await table.select('*', { order: 'created_at.desc' });
    const container = document.getElementById('blog-list');

    if (!Array.isArray(posts) || posts.length === 0) {
      container.innerHTML = '<p class="empty-state">No blog posts yet. Click "+ New Post" to create one.</p>';
      return;
    }

    container.innerHTML = posts.map(post => `
      <div class="blog-item">
        <div class="blog-item-info">
          <h4>${escapeHtml(post.title)}</h4>
          <span class="blog-item-meta">${post.status} · ${post.category || 'Uncategorized'} · ${new Date(post.created_at).toLocaleDateString()}</span>
        </div>
        <span class="status-badge status-${post.status === 'published' ? 'up' : 'pending'}">${post.status}</span>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error loading blog posts:', err);
  }
}

async function loadReviews() {
  try {
    const table = await supabase.from('reviews');
    const reviews = await table.select('*', { order: 'created_at.desc' });
    const container = document.getElementById('reviews-list');

    if (!Array.isArray(reviews) || reviews.length === 0) {
      container.innerHTML = '<p class="empty-state">No reviews yet. Add them manually or connect Google Business Profile.</p>';
      return;
    }

    container.innerHTML = reviews.map(r => `
      <div class="review-card">
        <div class="review-header">
          <strong>${escapeHtml(r.reviewer_name || 'Anonymous')}</strong>
          <span class="review-stars">${'★'.repeat(r.rating || 5)}${'☆'.repeat(5 - (r.rating || 5))}</span>
        </div>
        <p class="review-text">${escapeHtml(r.review_text || '')}</p>
        <div class="review-meta">${r.source || 'manual'} · ${r.display_on_site ? 'Displayed on site' : 'Hidden'}</div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error loading reviews:', err);
  }
}

// ---- Lead Status Update ----
window.updateLeadStatus = async function(leadId) {
  const newStatus = prompt('Enter new status (new, contacted, converted, closed):');
  if (!newStatus || !['new', 'contacted', 'converted', 'closed'].includes(newStatus)) return;

  try {
    const table = await supabase.from('leads');
    await table.update({ status: newStatus, updated_at: new Date().toISOString() }, `id=eq.${leadId}`);
    loadLeads();
    loadOverviewStats();
  } catch (err) {
    console.error('Error updating lead:', err);
  }
};

// ---- New Blog Post ----
document.getElementById('new-post-btn')?.addEventListener('click', () => {
  openModal('New Blog Post', `
    <form id="new-post-form">
      <div class="form-group"><label>Title</label><input type="text" id="post-title" required></div>
      <div class="form-group"><label>Category</label><input type="text" id="post-category" placeholder="e.g. Kitchen Remodeling"></div>
      <div class="form-group"><label>Content (Markdown)</label><textarea id="post-body" rows="10" style="width:100%;font-family:monospace;"></textarea></div>
      <div class="form-group"><label>Meta Description</label><textarea id="post-meta" rows="2" maxlength="160" style="width:100%;"></textarea></div>
      <button type="submit" class="btn-primary" style="margin-top:12px;">Save Draft</button>
    </form>
  `);

  document.getElementById('new-post-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('post-title').value;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    try {
      const table = await supabase.from('blog_posts');
      await table.insert({
        title,
        slug,
        body_markdown: document.getElementById('post-body').value,
        category: document.getElementById('post-category').value,
        meta_description: document.getElementById('post-meta').value,
        status: 'draft',
      });
      closeModal();
      loadBlogPosts();
      loadOverviewStats();
    } catch (err) {
      console.error('Error creating post:', err);
    }
  });
});

// ---- Add Review ----
document.getElementById('add-review-btn')?.addEventListener('click', () => {
  openModal('Add Review', `
    <form id="new-review-form">
      <div class="form-group"><label>Reviewer Name</label><input type="text" id="review-name" required></div>
      <div class="form-group"><label>Rating (1-5)</label><input type="number" id="review-rating" min="1" max="5" value="5" required></div>
      <div class="form-group"><label>Review Text</label><textarea id="review-text" rows="4" style="width:100%;"></textarea></div>
      <div class="form-group"><label>Source</label><select id="review-source"><option value="manual">Manual</option><option value="google">Google</option><option value="yelp">Yelp</option></select></div>
      <div class="form-group"><label class="checkbox-label"><input type="checkbox" id="review-display" checked> Display on website</label></div>
      <button type="submit" class="btn-primary" style="margin-top:12px;">Add Review</button>
    </form>
  `);

  document.getElementById('new-review-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const table = await supabase.from('reviews');
      await table.insert({
        reviewer_name: document.getElementById('review-name').value,
        rating: parseInt(document.getElementById('review-rating').value),
        review_text: document.getElementById('review-text').value,
        source: document.getElementById('review-source').value,
        display_on_site: document.getElementById('review-display').checked,
      });
      closeModal();
      loadReviews();
      loadOverviewStats();
    } catch (err) {
      console.error('Error adding review:', err);
    }
  });
});

// ---- Export Leads CSV ----
document.getElementById('export-leads-btn')?.addEventListener('click', async () => {
  try {
    const table = await supabase.from('leads');
    const leads = await table.select('*', { order: 'submitted_at.desc' });
    if (!Array.isArray(leads) || leads.length === 0) {
      alert('No leads to export.');
      return;
    }

    const headers = ['Name', 'Email', 'Phone', 'Source', 'Message', 'Status', 'Date'];
    const rows = leads.map(l => [
      l.name, l.email, l.phone, l.form_source, l.message, l.status,
      l.submitted_at ? new Date(l.submitted_at).toLocaleDateString() : '',
    ]);

    const csv = [headers, ...rows].map(r => r.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `uprise-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Error exporting leads:', err);
  }
});

// ---- Site Settings Form ----
document.getElementById('site-settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const updates = [
      { key: 'business_name', value: JSON.stringify(document.getElementById('set-biz-name').value) },
      { key: 'business_phone', value: JSON.stringify(document.getElementById('set-biz-phone').value) },
      { key: 'business_email', value: JSON.stringify(document.getElementById('set-biz-email').value) },
      { key: 'business_hours', value: JSON.stringify(document.getElementById('set-biz-hours').value) },
    ];
    for (const u of updates) {
      const table = await supabase.from('settings');
      await table.update({ value: u.value }, `key=eq.${u.key}`);
    }
    alert('Settings saved!');
  } catch (err) {
    console.error('Error saving settings:', err);
  }
});

// ---- Invite User ----
document.getElementById('invite-user-btn')?.addEventListener('click', () => {
  openModal('Invite User', `
    <form id="invite-form">
      <div class="form-group"><label>Email</label><input type="email" id="invite-email" required></div>
      <div class="form-group"><label>Name</label><input type="text" id="invite-name"></div>
      <div class="form-group"><label>Role</label><select id="invite-role"><option value="client">Client</option><option value="agency">Agency</option></select></div>
      <button type="submit" class="btn-primary" style="margin-top:12px;">Send Invite</button>
    </form>
  `);

  document.getElementById('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    alert('Invite system requires Supabase Auth admin setup. The user can be created in the Supabase dashboard for now.');
    closeModal();
  });
});

// ---- Utility: HTML Escape ----
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---- Initial Load ----
loadOverviewStats();
loadLeads();
loadBlogPosts();
loadReviews();
