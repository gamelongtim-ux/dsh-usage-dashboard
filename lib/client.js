// dsh-usage-dashboard —— 浏览器半边：在 Settings 左侧导航注册 "Usage dashboard" 分区，
// 内容以同源 iframe 内嵌仪表盘（页面本体由宿主侧插件挂在 /usage-dashboard/）。
// iframe 高度随内容自适应：滚动完全交给 Settings 弹窗自己的滚动条，不会出现双滚动条。
// 刻意保持：无第三方依赖、内容组件无 hooks（手写 React element），与壳子 React 实例安全共存；
// 工厂用 loader 行 id 与包名双 id 注册，兼容不同 dsh 版本的图条目 id。
'use strict';
(function register() {
  const DASHBOARD_PATH = '/usage-dashboard/';

  const IFRAME_STYLE = {
    width: '100%',
    height: '900px', // 初始占位，attachAutoHeight 会按内容校准
    minHeight: '480px',
    border: '0',
    borderRadius: '12px',
    background: 'transparent',
    display: 'block',
    colorScheme: 'normal',
  };

  /** iframe 高度跟随内容：message 通知 + load 轮询校准双保险（同源，可直接量 DOM）。 */
  function attachAutoHeight(frame) {
    if (!frame) return;
    const fit = () => {
      try {
        const d = frame.contentDocument;
        if (d && d.body) {
          const h = Math.max(d.documentElement.scrollHeight, d.body.scrollHeight, 480);
          frame.style.height = h + 'px';
        }
      } catch (_) { /* 理论上同源不会发生 */ }
    };
    frame.addEventListener('load', () => {
      fit();
      try {
        const d = frame.contentDocument;
        if (d && d.defaultView) {
          d.defaultView.addEventListener('resize', fit);
          let n = 0;
          const t = setInterval(() => { fit(); if (++n > 30) clearInterval(t); }, 300); // 渲染/图表分帧期校准
        }
      } catch (_) {}
    });
    window.addEventListener('message', e => {
      if (e.source !== frame.contentWindow) return;
      if (e.data && e.data.type === 'dsh-usage:height' && e.data.h > 100) {
        frame.style.height = (e.data.h + 6) + 'px';
      }
    });
  }

  /** Settings 分区内容组件。owner props 只有 {close}；纯函数组件，无 hooks。 */
  function makeSection(react) {
    return function UsageDashboardSection() {
      return react.createElement('iframe', {
        ref: attachAutoHeight,
        src: DASHBOARD_PATH,
        title: 'Usage dashboard',
        style: IFRAME_STYLE,
      });
    };
  }

  const factory = (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require('react');

    /** 必需服务（cordis fiber inject）。 */
    const inject = ['slots'];

    /**
     * 在 Settings 侧边栏挂一个分区。
     * @param {object} ctx - 浏览器端插件上下文（携带 slots 服务）。
     */
    function apply(ctx) {
      const Section = makeSection(react);
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'usage-dashboard',
        order: 50, // 排在内置 General/Models/Plugins/Agent presets 之后
        label: () => 'Usage dashboard',
      }, Section));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  };

  window.__ModuleLoader__.load({ id: 'dsh-usage-dashboard', factory });
  window.__ModuleLoader__.load({ id: 'usage-dashboard', factory });
})();
