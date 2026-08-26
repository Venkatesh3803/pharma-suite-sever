export const subscriptionNoticeTemplate = {
  subject: "PharmaSuite subscription update",
  htmlContent: (title: string, body: string): string => `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #ded7c4; background: #fff;">
      <div style="border-bottom: 1px solid #ded7c4; padding-bottom: 16px; margin-bottom: 16px;">
        <strong style="font-size: 16px; color: #0e3b36;">PharmaSuite</strong>
        <span style="color: #c1652b; font-size: 12px;"> · Subscription</span>
      </div>
      <h2 style="color: #14201c; font-size: 18px; margin: 0 0 8px;">${title}</h2>
      <p style="color: #14201c; font-size: 13.5px; line-height: 1.6; margin: 0 0 16px;">${body}</p>
      <p style="color: #14201c; font-size: 12px; line-height: 1.5;">
        Manage your plan from the <strong>Subscription</strong> page inside PharmaSuite.
      </p>
    </div>
  `,
  textContent: (title: string, body: string): string => `PharmaSuite Subscription Update\n\n${title}\n\n${body}\n\nManage your plan from the Subscription page inside PharmaSuite.`,
};
