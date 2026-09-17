// dsh-usage-dashboard —— 浏览器半边：在 Settings 左侧导航注册 "Usage dashboard" 分区，
// 内容以同源 iframe 内嵌仪表盘（页面本体由宿主侧插件挂在 /usage-dashboard/）。
// 客户端模块模型（dsh-client-modules）：懒加载 CJS 工厂表。这里刻意：
//   1) 不 require 任何共享模块（内容是静态 iframe，纯函数组件无需 hooks，手写 React element 即可，
//      规避不同打包产物间 React 实例/共享模块可用性差异）；
//   2) 用 loader 行 id 与包名两个 id 各注册一次同一工厂（浏览器 loader 按图里的条目 id 取工厂，
//      行 id 与包名哪个作 id 取决于 dsh 版本，双注册两者都覆盖）。
'use strict';
(function register() {
  const DASHBOARD_PATH = '/usage-dashboard/';

  /**
   * Settings 分区内容组件。owner props 只有 {close}。
   * 手写 React element（宿主 React 的 reconciler 直接渲染 iframe 宿主元素）。
   */
  function UsageDashboardSection() {
    return {
      $$typeof: Symbol.for('react.element'),
      type: 'iframe',
      key: null,
      ref: null,
      props: {
        src: DASHBOARD_PATH,
        title: 'Usage dashboard',
        style: {
          width: '100%',
          height: '100%',
          minHeight: '72vh',
          border: '0',
          borderRadius: '12px',
          background: '#0b0d0f',
        },
      },
      _owner: null,
    };
  }

  const factory = (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** 必需服务（cordis fiber inject）。 */
    const inject = ['slots'];

    /**
     * 在 Settings 侧边栏挂一个分区。
     * @param {object} ctx - 浏览器端插件上下文（携带 slots 服务）。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'usage-dashboard',
        order: 50, // 排在内置 General/Models/Plugins/Agent presets 之后
        label: () => 'Usage dashboard',
      }, UsageDashboardSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  };

  window.__ModuleLoader__.load({ id: 'dsh-usage-dashboard', factory });
  window.__ModuleLoader__.load({ id: 'usage-dashboard', factory });
})();
