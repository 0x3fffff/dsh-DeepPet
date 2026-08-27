window.__ModuleLoader__.load({
  // id 必须**逐字等于包名**：boot manifest 里的 row.id 就是包名，加载器拿它和
  // 这里注册的 id 对账，对不上就抛「loaded without registering」，整棵插件树
  // 加载失败。test/client-pkg.mjs 拿它和 package.json 的 name 对账。
  id: "@0x3fffff/dsh-deep-pet-client",
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
