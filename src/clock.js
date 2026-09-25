'use strict';

/**
 * 可注入时钟：所有“当前时间”一律经由 clock.now() 获取，
 * 升级引擎、发布时间、复核时间均依赖注入实例，测试可手动推进。
 */
function systemClock() {
  return { now: () => new Date() };
}

function manualClock(startIso) {
  let current = new Date(startIso);
  return {
    now: () => new Date(current.getTime()),
    set(iso) {
      current = new Date(iso);
    },
    advanceMs(ms) {
      current = new Date(current.getTime() + ms);
    },
    advanceDays(days) {
      current = new Date(current.getTime() + days * 24 * 60 * 60 * 1000);
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const err = new Error(`invalid datetime: ${value}`);
    err.name = 'InvalidDate';
    throw err;
  }
  return d.toISOString();
}

module.exports = { systemClock, manualClock, DAY_MS, toIso };
