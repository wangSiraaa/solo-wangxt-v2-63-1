/**
 * 可注入时钟：所有服务只通过 Clock 读取“当前时间”，
 * 验收测试可注入固定/快进时间，验证“未来规则不影响旧事件”“并发升级”等场景。
 */
export class Clock {
  private override: Date | null = null;

  /** 以 ISO 字符串设定当前时间；传 null 恢复系统时钟。 */
  setNow(iso: string | null): void {
    if (iso === null) {
      this.override = null;
      return;
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`invalid clock time: ${iso}`);
    }
    this.override = d;
  }

  now(): Date {
    return this.override ? new Date(this.override.getTime()) : new Date();
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /** 从基准时间推进小时数，返回新的 Date。 */
  plusHours(base: Date, hours: number): Date {
    return new Date(base.getTime() + Math.round(hours * 3600_000));
  }
}
