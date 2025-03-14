import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as ssm from 'aws-cdk-lib/aws-ssm'

export class CommonResourcesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // Define parameters
    const crossAccountPipelineRoleName = new cdk.CfnParameter(
      this,
      'CrossAccountPipelineRoleName',
      {
        type: 'String',
        description: 'The name of the cross account pipeline role',
      },
    )

    const crossAccountDeployerRoleName = new cdk.CfnParameter(
      this,
      'CrossAccountDeployerRoleName',
      {
        type: 'String',
        description: 'The name of the cross account deployer role',
      },
    )

    const organisationId = new cdk.CfnParameter(this, 'OrganisationId', {
      type: 'String',
      description: 'The Organisation Id for permissions',
    })

    // Define Pipeline Role
    const pipelineRole = new iam.Role(this, 'PipelineRole', {
      roleName: cdk.Fn.sub('${AWS::StackName}-codepipeline-role'),
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
      path: '/',
    })

    // Define Build Project Role
    const buildProjectRole = new iam.Role(this, 'BuildProjectRole', {
      roleName: cdk.Fn.sub('${AWS::StackName}-codebuild-role'),
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('codebuild.amazonaws.com'),
        new iam.ArnPrincipal(pipelineRole.roleArn),
      ),
      path: '/',
    })

    // Define KMS key
    const kmsKey = new kms.Key(this, 'KMSKey', {
      enableKeyRotation: true,
      description:
        'Used by Assumed Roles in Dev/Test/UAT/Prod accounts to Encrypt/Decrypt code',
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'Allows admin of the key',
            effect: iam.Effect.ALLOW,
            principals: [new iam.AccountRootPrincipal()],
            actions: [
              'kms:Create*',
              'kms:Describe*',
              'kms:Enable*',
              'kms:List*',
              'kms:Put*',
              'kms:Update*',
              'kms:Revoke*',
              'kms:Disable*',
              'kms:Get*',
              'kms:Delete*',
              'kms:ScheduleKeyDeletion',
              'kms:CancelKeyDeletion',
            ],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'Allow use of the key in Code Build projects',
            effect: iam.Effect.ALLOW,
            principals: [
              new iam.ArnPrincipal(buildProjectRole.roleArn),
              new iam.ArnPrincipal(pipelineRole.roleArn),
            ],
            actions: [
              'kms:Encrypt',
              'kms:Decrypt',
              'kms:ReEncrypt*',
              'kms:GenerateDataKey*',
              'kms:DescribeKey',
            ],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'Allow use of the key in accounts within the organisation',
            effect: iam.Effect.ALLOW,
            actions: [
              'kms:Encrypt',
              'kms:Decrypt',
              'kms:ReEncrypt*',
              'kms:GenerateDataKey*',
              'kms:DescribeKey',
            ],
            principals: [new iam.ArnPrincipal('*')],
            resources: ['*'],
            conditions: {
              StringEquals: {
                'aws:PrincipalOrgID': organisationId.valueAsString,
              },
            },
          }),
        ],
      }),
    })

    // Define KMS alias
    new kms.Alias(this, 'KMSAlias', {
      aliasName: `alias/${cdk.Stack.of(this).stackName}-CMKARN`,
      targetKey: kmsKey,
    })

    // Define S3 bucket
    const s3Bucket = new s3.Bucket(this, 'S3Bucket', {
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // Define Pipeline Policy
    new iam.Policy(this, 'PipelinePolicy', {
      policyName: cdk.Fn.sub('${AWS::StackName}-codepipeline-policy'),
      roles: [pipelineRole],
      document: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'codepipeline:*',
              'iam:ListRoles',
              'cloudformation:Describe*',
              'cloudformation:List*',
              'codecommit:List*',
              'codecommit:Get*',
              'codecommit:GitPull',
              'codecommit:UploadArchive',
              'codecommit:CancelUploadArchive',
              'codebuild:BatchGetBuilds',
              'codebuild:StartBuild',
              'cloudformation:CreateStack',
              'cloudformation:DeleteStack',
              'cloudformation:DescribeStacks',
              'cloudformation:UpdateStack',
              'cloudformation:CreateChangeSet',
              'cloudformation:DeleteChangeSet',
              'cloudformation:DescribeChangeSet',
              'cloudformation:ExecuteChangeSet',
              'cloudformation:SetStackPolicy',
              'cloudformation:ValidateTemplate',
              'iam:PassRole',
              's3:ListAllMyBuckets',
              's3:GetBucketLocation',
              'sns:*',
            ],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
            resources: [kmsKey.keyArn],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              's3:PutObject',
              's3:GetBucketPolicy',
              's3:GetObject',
              's3:ListBucket',
            ],
            resources: [s3Bucket.bucketArn, `${s3Bucket.bucketArn}/*`],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sts:AssumeRole'],
            resources: [
              cdk.Fn.sub('arn:aws:iam::*:role/${CrossAccountPipelineRoleName}'),
            ],
          }),
        ],
      }),
    })

    // Define Build Project Policy
    new iam.Policy(this, 'BuildProjectPolicy', {
      policyName: cdk.Fn.sub('${AWS::StackName}-codebuild-policy'),
      roles: [buildProjectRole],
      document: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              's3:PutObject',
              's3:GetBucketPolicy',
              's3:GetObject',
              's3:ListBucket',
            ],
            resources: [s3Bucket.bucketArn, `${s3Bucket.bucketArn}/*`],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['kms:*'],
            resources: [kmsKey.keyArn],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'codecommit:List*',
              'codecommit:Get*',
              'codecommit:GitPull',
              'codecommit:UploadArchive',
              'codecommit:CancelUploadArchive',
            ],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['cloudformation:*'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['iam:PassRole'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codestar-connections:*'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:*'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'logs:CreateLogGroup',
              'logs:CreateLogStream',
              'logs:PutLogEvents',
            ],
            resources: ['arn:aws:logs:*:*:*'],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sts:AssumeRole'],
            resources: [
              cdk.Fn.sub('arn:aws:iam::*:role/${CrossAccountDeployerRoleName}'),
            ],
          }),
        ],
      }),
    })

    // Store ARNs and other values in SSM parameters
    new ssm.StringParameter(this, 'BuildProjectRoleARNParameter', {
      parameterName: `/CodePipelineCDK/CommonResources/BuildProjectRoleARN`,
      stringValue: buildProjectRole.roleArn,
    })

    new ssm.StringParameter(this, 'PipelineRoleARNParameter', {
      parameterName: `/CodePipelineCDK/CommonResources/PipelineRoleARN`,
      stringValue: pipelineRole.roleArn,
    })

    new ssm.StringParameter(this, 'CMKARNParameter', {
      parameterName: `/CodePipelineCDK/CommonResources/CMKARN`,
      stringValue: kmsKey.keyArn,
    })

    new ssm.StringParameter(this, 'S3BucketParameter', {
      parameterName: `/CodePipelineCDK/CommonResources/S3Bucket`,
      stringValue: s3Bucket.bucketName,
    })

    new ssm.StringParameter(this, 'CrossAccountPipelineRoleNameParameter', {
      parameterName: `/CodePipelineCDK/CommonResources/CrossAccountPipelineRoleName`,
      stringValue: crossAccountPipelineRoleName.valueAsString,
    })

    new ssm.StringParameter(this, 'CrossAccountDeployerRoleNameParameter', {
      parameterName: `/CodePipelineCDK/CommonResources/CrossAccountDeployerRoleName`,
      stringValue: crossAccountDeployerRoleName.valueAsString,
    })

    // Define bucket policy
    const bucketPolicy = new iam.PolicyStatement({
      actions: ['s3:*'],
      effect: iam.Effect.ALLOW,
      resources: [s3Bucket.bucketArn, `${s3Bucket.bucketArn}/*`],
      principals: [new iam.ArnPrincipal(buildProjectRole.roleArn)],
    })

    const bucketPolicyWithCondition = new iam.PolicyStatement({
      actions: ['s3:*'],
      effect: iam.Effect.ALLOW,
      resources: [s3Bucket.bucketArn, `${s3Bucket.bucketArn}/*`],
      principals: [new iam.AnyPrincipal()],
      conditions: {
        StringEquals: {
          'aws:PrincipalOrgID': organisationId.valueAsString,
        },
        ArnLike: {
          'aws:PrincipalArn': [
            `arn:aws:iam::*:role/${crossAccountPipelineRoleName.valueAsString}`,
            `arn:aws:iam::*:role/${crossAccountDeployerRoleName.valueAsString}`,
          ],
        },
      },
    })

    // Attach bucket policy to the S3 bucket
    s3Bucket.addToResourcePolicy(bucketPolicy)
    s3Bucket.addToResourcePolicy(bucketPolicyWithCondition)
  }
}
