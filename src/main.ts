import {
  emit,
  loadSettingsAsync,
  on,
  saveSettingsAsync,
  showUI,
} from "@create-figma-plugin/utilities";
import { isFigmaGeneratedName, isValidFigmaNodeType } from "./figma-node-types";
import { NamingStrategyManager } from "./naming-strategies/manager";
import { AllOptions } from "./types";

// 定义插件生成的图层名称列表
const PLUGIN_GENERATED_NAMES = [
  "group",
  "frame",
  "grid",
  "row",
  "col",
  "video",
  "image",
  "boolean-union",
  "boolean-subtract",
  "boolean-intersect",
  "boolean-exclude",
];

// 创建插件生成的图层名称模式的正则表达式
const PLUGIN_NAME_PATTERN = new RegExp(
  `^(${PLUGIN_GENERATED_NAMES.join("|")})(-\\[\\d+(?:,\\s*\\d+)?\\])?$`
);

// 初始化命名策略管理器
const namingManager = new NamingStrategyManager();

/**
 * 重命名单个图层
 * @param node 要重命名的图层节点
 * @param options 重命名选项
 * @returns 如果图层被重命名则返回 Promise<boolean>
 */
async function renameLayer(
  node: SceneNode,
  options: AllOptions
): Promise<boolean> {
  try {
    // 根据选项跳过特定类型的图层
    if (node.locked && !options.locked) return false;
    if (node.visible === false && !options.hidden) return false;
    if (node.type === "INSTANCE" && !options.instance) return false;

    // 检查是否需要重命名用户自定义的图层名称
    if (!options.renameCustomNames && !isFigmaOrPluginGeneratedName(node)) {
      return false;
    }

    const newName = await namingManager.generateName(node, options);
    if (node.name !== newName) {
      node.name = newName;
      return true;
    }
    return false;
  } catch (error) {
    console.error(`重命名错误 (${node.id}):`, error);
    figma.notify(`重命名失败: ${node.name}`, { error: true });
    return false;
  }
}

/**
 * 批量处理节点
 * @param nodes 要处理的节点数组
 * @param options 重命名选项
 */
async function processBatchNodes(
  nodes: readonly SceneNode[],
  options: AllOptions
): Promise<boolean> {
  const batchSize = 50;
  let hasRenamed = false;

  for (let i = 0; i < nodes.length; i += batchSize) {
    const batch = nodes.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((node) => renameNodeAndChildren(node, options))
    );
    hasRenamed = hasRenamed || results.some((result) => result);

    // 每批处理完后暂停一下，避免阻塞主线程
    if (i + batchSize < nodes.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return hasRenamed;
}

/**
 * 重命名选中的图层
 * @param options 重命名选项
 * @returns 是否有任何图层被重命名
 */
function renameLayersInSelection(options: AllOptions): Promise<boolean> {
  return new Promise(async (resolve) => {
    const selection = figma.currentPage.selection;
    const hasRenamed = await processBatchNodes(selection, options);
    resolve(hasRenamed);
  });
}

/**
 * 递归函数，用于重命名节点及其子节点
 * @param node 要处理的节点
 * @param options 重命名选项
 * @returns 是否有任何节点被重命名
 */
async function renameNodeAndChildren(
  node: SceneNode,
  options: AllOptions
): Promise<boolean> {
  // 如果是实例且未启用实例重命名，直接返回
  if (node.type === "INSTANCE" && !options.instance) {
    return false;
  }

  let hasRenamed = await renameLayer(node, options);

  // 只有在非实例节点或启用了实例重命名的情况下才处理子节点
  if ("children" in node && (node.type !== "INSTANCE" || options.instance)) {
    const childResults = await Promise.all(
      node.children.map((child) => renameNodeAndChildren(child, options))
    );
    hasRenamed = hasRenamed || childResults.some((result) => result);
  }

  return hasRenamed;
}

/**
 * 判断图层名称是否为 Figma 或插件自动生成的
 * @param node 图层节点
 * @returns 是否为 Figma 或插件自动生成的名称
 */
function isFigmaOrPluginGeneratedName(node: SceneNode): boolean {
  const name = node.name;

  // 验证节点类型
  if (!isValidFigmaNodeType(node.type)) {
    console.warn(`未知的 Figma 节点类型: ${node.type}`);
    return false;
  }

  // 处理文本节点
  if (node.type === "TEXT") {
    return (node as TextNode).autoRename || name === "text";
  }

  // 组件类型的特殊处理
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    return /^\S+\s\d+$/.test(name);
  }

  // 检查是否为 Figma 生成的名称
  if (isFigmaGeneratedName(name)) {
    return true;
  }

  // 检查是否匹配插件生成的名称模式
  return PLUGIN_NAME_PATTERN.test(name);
}

/**
 * 插件主函数
 */
export default async function () {
  // 设置 UI 窗口大小
  const uiOptions = {
    width: 240,
    height: 262,
  };

  // 加载保存的设置
  const savedOptions: AllOptions = await loadSettingsAsync(
    {
      locked: false,
      hidden: false,
      instance: false,
      showSpacing: false,
      renameCustomNames: false,
      usePascalCase: false,
    },
    "allOptions"
  );

  const data = {
    savedOptions: savedOptions,
    initialSelection: figma.currentPage.selection.length > 0,
  };

  // 显示 UI
  showUI(uiOptions, data);

  // 监听选中变化
  figma.on("selectionchange", () => {
    emit("SELECTION_CHANGED", figma.currentPage.selection.length > 0);
  });

  // 监听 UI 设置面板开关事件
  on("SETTING_OPEN", (settingOpen: boolean) => {
    figma.ui.resize(240, settingOpen ? 262 : 408);
  });

  // 监听重命名事件
  on("RENAME", async (receivedOptions: AllOptions) => {
    try {
      // 设置实例子节点的可见性处理
      figma.skipInvisibleInstanceChildren = !(
        receivedOptions.instance && receivedOptions.hidden
      );

      // 保存用户的选项
      await saveSettingsAsync(receivedOptions, "allOptions");

      // 执行重命名操作
      const hasRenamed = await renameLayersInSelection(receivedOptions);

      // 显示操作结果通知
      if (hasRenamed) {
        figma.notify("🎉 重命名完成！");
      } else {
        figma.notify("😶‍🌫️ 没有图层需要重命名");
      }
    } catch (error) {
      console.error("重命名过程出错:", error);
      figma.notify("❌ 重命名过程中出现错误", { error: true });
    }
  });
}
