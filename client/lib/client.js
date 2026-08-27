window.__ModuleLoader__.load({
  id: "dsh-deep-pet-client",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    var inject = ["slots", "connection"];

    function PetLaunchButton(props) {
      return React.createElement(
        "button",
        {
          type: "button",
          title: "启动桌宠；已启动则重置到默认位置",
          onClick: function () { void props.onLaunch(); },
        },
        "启动桌宠"
      );
    }

    function apply(ctx) {
      var rpc = ctx.get("connection").rpc;

      // 把本页的地址报给插件，插件再转给桌宠——桌宠右键菜单的「打开 DSH」
      // 需要它。桌宠自己无从知道这个地址：会合登记里只有插件 WS 服务的端口，
      // 而网页服务是另一个。这里是整条链路上唯一天然知道答案的地方。
      try {
        rpc.call("/pet", "web-url", { url: window.location.origin }).catch(function () {});
      } catch (err) { /* 报不上去就只是少一个菜单项，不该拖垮按钮 */ }

      var onLaunch = function () {
        return rpc.call("/pet", "launch", {}).catch(function (err) {
          return { ok: false, error: { message: String((err && err.message) || err) } };
        });
      };

      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "deep-pet-launch",
            order: 10,
            label: "启动桌宠",
            inject: function () { return { onLaunch: onLaunch }; },
          },
          PetLaunchButton
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
