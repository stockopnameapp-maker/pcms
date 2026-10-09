// Role-by-role crawl: every demo role opens every list, record, dashboard and report it is
// permitted to use. Nothing may return 5xx, and anything the role is allowed to read must be 200.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { close, login } from './helpers.js';

after(close);

const USERS = ['kas.superadmin', 'kas.corporate', 'kas.meddirector', 'kas.estate.bcpj-ra', 'kas.dr.bcpj-ra-kln', 'kas.nurse1.bcpj-ra-kln',
  'kas.apt.bcpj-ra-kln', 'kas.hrmanager.bcpj', 'kas.hseofficer.bcpj-ra', 'kas.warehouse', 'kas.employee'];

for (const username of USERS) {
  test(`smoke: ${username}`, async () => {
    const c = await login(username);
    const failures: string[] = [];
    const check = async (url: string, query?: any, expect200 = true) => {
      const r = await c.get(url, query);
      if (r.status >= 500 || (expect200 && r.status !== 200)) failures.push(`${url} ${JSON.stringify(query ?? {})} → ${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`);
      return r;
    };
    const me = (await check('/auth/me')).body;
    const top = me.scopes.reduce((a: any, s: any) => (!a || s.depth < a.depth ? s : a), null);
    const meta = (await check('/meta/resources')).body;
    for (const r of meta.resources.filter((x: any) => x.permissions.read)) {
      const list = await check(`/r/${r.key}`, { pageSize: 3 });
      const row = list.body?.data?.[0];
      if (row?.id) await check(`/r/${r.key}/${row.id}`);
    }
    await check('/notifications', { limit: 5 });
    await check('/search', { q: 'an' });
    await check('/org/tree');
    if (me.permissions.DASHBOARD && top) {
      for (const [u, qy] of [['/dashboard/summary', {}], ['/dashboard/trend', { metric: 'visits' }], ['/dashboard/top-diseases', {}], ['/dashboard/drilldown', {}],
        ['/dashboard/clinic-performance', {}], ['/dashboard/accidents', {}], ['/dashboard/occupational', {}], ['/dashboard/medicine', {}], ['/finance/costs', { dimension: 'estate' }]] as const) {
        await check(u, { unitId: top.id, ...qy });
      }
    }
    if (top) {
      const reports = (await check('/reports')).body.data;
      for (const rep of reports.filter((x: any) => x.allowed)) await check(`/reports/${rep.code}`, { unitId: top.id });
    }
    if (me.user.employee_id) await check('/portal/summary');
    if (me.permissions.INVENTORY) { await check('/pharmacy/stock'); await check('/pharmacy/stock/summary'); }
    if (me.permissions.PHARMACY) await check('/pharmacy/prescriptions');
    if (me.permissions.LAB) await check('/lab/worklist');
    if (me.permissions.OCC_HEALTH) await check('/occ-health/compliance');
    if (me.permissions.QUEUE && me.user.staff) await check('/queue/board', { clinicId: me.user.staff.home_clinic_id });
    if (me.permissions.AUDIT) await check('/audit', { pageSize: 5 });
    if (me.permissions.USER_ADMIN) await check('/admin/roles');
    await check('/auth/sessions');
    assert.deepEqual(failures, [], `${username}:\n${failures.join('\n')}`);
  });
}
