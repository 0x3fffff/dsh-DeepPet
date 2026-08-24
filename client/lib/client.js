window.__ModuleLoader__.load({
  id: "dsh-deep-pet-client",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

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
      var slots = ctx.get("slots");
      if (slots === undefined) return;
      var connection = ctx.get("connection");
      if (connection === undefined || connection.rpc === undefined) return;
      var rpc = connection.rpc;

      var onLaunch = function () {
        // 结果 { ok, value:{action} } 或 { ok:false, error }；按钮暂时只触发，不展示结果。
        return rpc.call("/pet", "launch", {}).catch(function (err) {
          return { ok: false, error: { message: String((err && err.message) || err) } };
        });
      };

      slots.inject("sidebar.footer.action", function () {
        return slots.register(
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
    return module.exports;
  },
});
