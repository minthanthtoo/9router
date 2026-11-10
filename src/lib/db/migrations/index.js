// Migration registry — append new entries when schema changes.
// Each migration: { version: number, name: string, up(db): void }
// Versions MUST be unique and monotonically increasing.
import m001 from "./001-initial.js";
import m002 from "./002-image-quota-state.js";
import m003 from "./003-image-quota-management.js";
import m004 from "./004-image-quota-dispatch.js";
import m005 from "./005-image-request-attempts.js";
import m006 from "./006-image-request-submissions.js";
import m007 from "./007-image-quota-trace-fallback.js";
import m008 from "./008-image-submission-quota-fallback.js";
import m009 from "./009-image-quota-admission-fallback.js";
import m010 from "./010-image-supplier-exposure.js";

import m012 from "./012-image-quota-learning.js";
import m013 from "./013-image-quota-learning-predictions.js";
import m014 from "./014-image-quota-identity-history-index.js";

import m015 from "./015-admin-image-test-runs.js";

import m016 from "./016-image-routing-cursors.js";

import m017 from "./017-provider-rotation.js";
import m018 from "./018-text-model-permissions.js";
import m019 from "./019-admin-image-test-waiting-reset.js";

import m020 from "./020-credit-reset-attempts.js";

export const MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m012, m013, m014, m015, m016, m017, m018, m019, m020].sort((a, b) => a.version - b.version);

export function latestVersion() {
  return MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
}
