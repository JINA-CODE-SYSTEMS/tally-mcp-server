export interface ModelPullReportOutputFieldInfo {
    identifier: string;
    name: string;
    datatype: string;
    fields?: ModelPullReportOutputFieldInfo[];
}

export interface ModelPullReportInputInfo {
    name: string;
    datatype: string;
    validation_regex?: string;
    validation_message?: string;
}

export interface ModelPullReportOutputInfo {
    datatype: string;
    fields?: ModelPullReportOutputFieldInfo[];
}

export interface ModelPullResponse {
    data: any | undefined;
    error?: string;
}

export interface ModelPullReportInfo {
    name: string;
    input: ModelPullReportInputInfo[];
    output: ModelPullReportOutputInfo;
}

export interface ModelPushTemplateInputInfo {
    name: string;
    datatype: string;
    required: boolean;
    validation_regex?: string;
    validation_message?: string;
}

export interface ModelPushTemplateInfo {
    name: string;
    input: ModelPushTemplateInputInfo[];
}

export interface ModelPushResponse {
    success: boolean;
    created: number;
    altered: number;
    lastVchId: number;
    error?: string;
}