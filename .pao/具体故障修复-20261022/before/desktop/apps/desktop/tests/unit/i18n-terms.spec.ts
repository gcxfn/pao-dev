/** S3-4 术语改词守卫：钉住词典新值（「配方」→「工作流」、「实例」→「运行记录」），
 *  防止词典被回退或被机械替换弄脏。键（英文源串）是兼容契约，不在守卫范围。 */
import { test, expect } from "@playwright/test";
import { zhTranslations } from "../../contracts/i18n-zh";
import { enTranslations } from "../../contracts/i18n-en";

test("工作流画布与看板词条：用户可见文案用「工作流／运行记录」", () => {
  const zh: Record<string, string> = {
    "Suspended / failed workflow instances": "挂起/异常工作流运行记录",
    "Suspended instances": "挂起运行记录",
    "Instance anomalies": "运行记录异常",
    Recipes: "工作流库",
    "Recipe failed validation": "工作流校验未通过",
    Instances: "运行记录",
    Recipe: "选工作流",
    "This recipe takes no parameters.": "该工作流没有参数。",
    "Recipe value": "工作流值",
  };
  for (const [key, value] of Object.entries(zh)) {
    expect(zhTranslations[key], key).toBe(value);
  }
  // 换词后中文值不得再含旧术语（本批词条面）。
  for (const value of Object.values(zh)) {
    expect(value).not.toMatch(/配方|实例/);
  }
});

test("英文覆盖词条与新术语同步", () => {
  expect(enTranslations["The recipe for this instance could not be read; nodes are listed without edges."]).toBe(
    "This run record has no readable frozen workflow. Card mappings are shown; original edges and positions are unknown.",
  );
});
