import * as cdk from 'aws-cdk-lib/core'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline'
import {
  CloudFormationCreateUpdateStackAction,
  CodeBuildAction,
  CodeStarConnectionsSourceAction,
  ManualApprovalAction,
} from 'aws-cdk-lib/aws-codepipeline-actions'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as ssm from 'aws-cdk-lib/aws-ssm' // Add this line
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { Construct } from 'constructs'
import { LinuxBuildImage } from 'aws-cdk-lib/aws-codebuild'
import * as uuid from 'uuid'

export class CDPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const branchName = new cdk.CfnParameter(this, 'BranchName', {
      type: 'String',
      description: 'Name of the branch',
      default: 'main',
    })

    const branchTemplateName = new cdk.CfnParameter(
      this,
      'BranchTemplateName',
      {
        type: 'String',
        description: 'Name of the CF template',
        default: 'template.yaml',
      },
    )

    const codeStarConnectionId = new cdk.CfnParameter(
      this,
      'CodeStarConnectionId',
      {
        type: 'String',
        description: 'The codestar connection ID',
      },
    )

    const dependencyFolders = new cdk.CfnParameter(this, 'DependencyFolders', {
      type: 'String',
      description:
        'csv list of folders in the source repo to be copied to the dependency bucket',
      default: '',
    })

    const nonProductionAccount = new cdk.CfnParameter(
      this,
      'NonProductionAccount',
      {
        type: 'Number',
        description: 'AWS AccountNumber for Non-Production',
      },
    )

    const productionAccount = new cdk.CfnParameter(this, 'ProductionAccount', {
      type: 'Number',
      description: 'AWS AccountNumber for Production',
    })

    const repositoryName = new cdk.CfnParameter(this, 'RepositoryName', {
      type: 'String',
      description: 'Name of the Project',
    })

    const repositoryOwner = new cdk.CfnParameter(this, 'RepositoryOwner', {
      type: 'String',
      description: 'Repository Owner',
    })

    const stackName = new cdk.CfnParameter(this, 'StackName', {
      type: 'String',
      description: 'lowercase name of stack',
    })

    const artifactBucketName = ssm.StringParameter.valueForStringParameter(
      this,
      '/CodePipelineCDK/CommonResources/S3Bucket',
    )

    const encryptionKeyArn = ssm.StringParameter.valueForStringParameter(
      this,
      '/CodePipelineCDK/CommonResources/CMKARN',
    )

    const pipelineRoleArn = ssm.StringParameter.valueForStringParameter(
      this,
      '/CodePipelineCDK/CommonResources/PipelineRoleARN',
    )

    const buildRoleArn = ssm.StringParameter.valueForStringParameter(
      this,
      '/CodePipelineCDK/CommonResources/BuildProjectRoleARN',
    )

    const artifactBucket = s3.Bucket.fromBucketName(
      this,
      'ArtifactBucket',
      artifactBucketName,
    )

    const encryptionKey = kms.Key.fromKeyArn(
      this,
      'EncryptionKey',
      encryptionKeyArn,
    )

    const pipelineRole = iam.Role.fromRoleArn(
      this,
      'PipelineRole',
      pipelineRoleArn,
    )

    const crossAccountDeployerRoleName =
      ssm.StringParameter.valueForStringParameter(
        this,
        '/CodePipelineCDK/CommonResources/CrossAccountDeployerRoleName',
      )

    const crossAccountPipelineRoleName =
      ssm.StringParameter.valueForStringParameter(
        this,
        '/CodePipelineCDK/CommonResources/CrossAccountPipelineRoleName',
      )

    const buildRole = iam.Role.fromRoleArn(this, 'BuildRole', buildRoleArn)

    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      description: stackName.valueAsString,
      encryptionKey: encryptionKey,
      environment: {
        computeType: codebuild.ComputeType.SMALL,
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_5,
        environmentVariables: {
          S3Bucket: {
            value: artifactBucketName,
          },
          S3BuildsPrefix: { value: cdk.Fn.sub('${StackName}/builds') },
          TemplateName: { value: branchTemplateName.valueAsString },
          KMSKey: {
            value: encryptionKeyArn,
          },
          DependencyFolders: { value: dependencyFolders.valueAsString },
        },
      },
      role: buildRole,
      queuedTimeout: cdk.Duration.minutes(10),
    })

    // deploy project
    const deployBuildProject = new codebuild.PipelineProject(
      this,
      'DeployBuildProject',
      {
        description: `${stackName.valueAsString} - Deploy Build`,
        encryptionKey: encryptionKey,
        environment: {
          computeType: codebuild.ComputeType.SMALL,
          buildImage: LinuxBuildImage.AMAZON_LINUX_2_5,
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: {
            build: {
              commands: `
            RESPONSE=$(aws sts assume-role --role-arn arn:aws:iam::$AccountNumber:role/$RoleArn --role-session-name $(date "+%Y%m%d_%H%M%S"))
            export AWS_ACCESS_KEY_ID=$(echo $RESPONSE | jq -r '.Credentials.AccessKeyId')
            export AWS_SECRET_ACCESS_KEY=$(echo $RESPONSE | jq -r '.Credentials.SecretAccessKey')
            export AWS_SESSION_TOKEN=$(echo $RESPONSE | jq -r '.Credentials.SessionToken')
            
            STACK_NAME="$StackName-$Environment"
            BRANCH_NAME=$BranchName
            echo "The branch name is: $BRANCH_NAME"

            SANITISED_BRANCH=$(echo $BRANCH_NAME | sed 's/[\/\\]/-/g')
            echo "The sanitised branch name is: $SANITISED_BRANCH"
            MODIFIED_STACK_NAME=$STACK_NAME-$SANITISED_BRANCH
            echo "Deploying template TemplateName.yaml as stack '$MODIFIED_STACK_NAME'"
            aws cloudformation deploy --template-file packaged-template.yaml --parameter-overrides file://packaged-template-dev-params.json --stack-name $MODIFIED_STACK_NAME --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset
        `,
            },
          },
          artifacts: {
            files: ['**/*'],
            'discard-paths': 'yes',
          },
        }),
        role: buildRole,
        queuedTimeout: cdk.Duration.minutes(10),
      },
    )

    const sourceAction = new CodeStarConnectionsSourceAction({
      actionName: 'App',
      owner: repositoryOwner.valueAsString,
      repo: repositoryName.valueAsString,
      branch: branchName.valueAsString,
      connectionArn: `arn:aws:codestar-connections:ap-southeast-2:${cdk.Aws.ACCOUNT_ID}:connection/${codeStarConnectionId.valueAsString}`,
      output: new codepipeline.Artifact('SCCheckoutArtifact'),
      role: buildRole,
      runOrder: 1,
      variablesNamespace: 'SourceVariables',
      triggerOnPush: true,
    })

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'CodePipelineCDKDemo-CD-Pipeline',
      executionMode: codepipeline.ExecutionMode.QUEUED,
      role: pipelineRole,
      artifactBucket: artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },

        {
          stageName: 'Build',
          actions: [
            new CodeBuildAction({
              actionName: 'BuildAndPackage',
              project: buildProject,
              input: new codepipeline.Artifact('SCCheckoutArtifact'),
              outputs: [new codepipeline.Artifact('BuildOutput')],
              role: pipelineRole,
              runOrder: 1,
            }),
          ],
        },
      ],
    })

    const crossAccountDevDeployerRole = iam.Role.fromRoleArn(
      this,
      'CrossAccountDevDeployerRole',
      `arn:aws:iam::${nonProductionAccount.valueAsString}:role/${crossAccountDeployerRoleName}`,
      {
        // Ensure the role can be assumed by the pipeline
        mutable: false,
      },
    )

    const crossAccountDevPipelineRole = iam.Role.fromRoleArn(
      this,
      'CrossAccountDevPipelineRole',
      `arn:aws:iam::${nonProductionAccount.valueAsString}:role/${crossAccountPipelineRoleName}`,
      {
        // Ensure the role can be assumed by the pipeline
        mutable: false,
      },
    )

    // Create a Lambda function to handle the event
    const pipelineStatusLambda = new lambda.Function(
      this,
      'PipelineStatusLambda',
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline(`
              const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
      
              const ssmClient = new SSMClient({});
      
              exports.handler = async (event) => {
                try {
                  console.log('Event:', JSON.stringify(event));

                  const input = {
                    Name: "ProdToggle",
                  };
                  const command = new GetParameterCommand(input);
                  const response = await ssmClient.send(command); 
                  const parameterValue = response.Parameter?.Value;

                  const body = {
                    parameterValue ? "Succeeeded" : "Failed"
                  }  


                  console.log("Returning response:", JSON.stringify(body));
                  return {
                    statusCode: 200,
                    body: JSON.stringify(body),
                  };
                } catch (error) {
                  console.error('Error processing CodePipeline event:', error);
                
                  return {
                    statusCode: 500,
                    body: JSON.stringify({ 
                      "Status": "Failed",
                    })
                  };
                }
              }
            `),
      },
    )

    // Grant the Lambda function permissions to read the pipeline status
    pipelineStatusLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'codepipeline:GetPipelineExecution',
          'codepipeline:PutJobSuccessResult',
          'codepipeline:PutJobFailureResult',
        ],
        resources: ['*'],
      }),
    )

    // secrets manager permissions
    pipelineStatusLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParam*'],
        resources: [
          `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/*`,
        ],
      }),
    )

    // Dev Stage
    pipeline.addStage({
      stageName: 'DeployDev',
      actions: [
        new CloudFormationCreateUpdateStackAction({
          actionName: 'CreateUpdateStackDev',
          stackName: `${stackName.valueAsString}-dev`,
          templatePath: new codepipeline.Artifact('BuildOutput').atPath(
            'packaged-template.yaml',
          ),
          adminPermissions: true,
          account: nonProductionAccount.valueAsString,
          cfnCapabilities: [
            cdk.CfnCapabilities.NAMED_IAM,
            cdk.CfnCapabilities.AUTO_EXPAND,
          ],
          deploymentRole: crossAccountDevDeployerRole,
          role: crossAccountDevPipelineRole,
          runOrder: 1,
          templateConfiguration: new codepipeline.Artifact(
            'BuildOutput',
          ).atPath('packaged-template-dev-params.json'),
        }),
      ],
    })

    // ApproveDeployProd Stage
    const approveDeployProdStage = pipeline.addStage({
      stageName: 'ApproveDeployProd',
      actions: [],
    })

    // Add ManualApprovalAction only if SkipApproval is false

    approveDeployProdStage.addAction(
      new ManualApprovalAction({
        actionName: 'ApproveDeployProd',
        additionalInformation:
          'Ensure that the associated Change Request for a deployment to Production is approved.',
      }),
    )

    const crossAccountProdDeployerRole = iam.Role.fromRoleArn(
      this,
      'CrossAccountProdDeployerRole',
      `arn:aws:iam::${productionAccount.valueAsString}:role/${crossAccountDeployerRoleName}`,
      {
        // Ensure the role can be assumed by the pipeline
        mutable: false,
      },
    )

    const crossAccountProdPipelineRole = iam.Role.fromRoleArn(
      this,
      'CrossAccountProdPipelineRole',
      `arn:aws:iam::${productionAccount.valueAsString}:role/${crossAccountPipelineRoleName}`,
      {
        // Ensure the role can be assumed by the pipeline
        mutable: false,
      },
    )

    // Prod Stage
    pipeline.addStage({
      stageName: 'DeployProd',
      actions: [
        new CloudFormationCreateUpdateStackAction({
          actionName: 'CreateUpdateStackProd',
          stackName: `${stackName.valueAsString}-prod`,
          templatePath: new codepipeline.Artifact('BuildOutput').atPath(
            'packaged-template.yaml',
          ),
          adminPermissions: true,
          account: productionAccount.valueAsString,
          cfnCapabilities: [
            cdk.CfnCapabilities.NAMED_IAM,
            cdk.CfnCapabilities.AUTO_EXPAND,
          ],
          deploymentRole: crossAccountProdDeployerRole,
          role: crossAccountProdPipelineRole,
          runOrder: 1,
          templateConfiguration: new codepipeline.Artifact(
            'BuildOutput',
          ).atPath('packaged-template-prod-params.json'),
        }),
      ],
    })
  }
}
